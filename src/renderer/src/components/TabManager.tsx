import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { LogEditorApi, OpenedFile, SearchMatch, SearchResultItem } from '@renderer/env'
import { SearchResultsPanel } from './tab-manager/SearchResultsPanel'
import { LINE_NUMBER_GUTTER_WIDTH } from './tab-manager/constants'
import { clamp } from './tab-manager/helpers'
import { Minimap } from './tab-manager/Minimap'
import { WindowedScrollBar } from './tab-manager/WindowedScrollBar'
import { useTabsController } from './tab-manager/useTabsController'
import {
  isFileTab,
  isSearchTab,
  isWelcomeTab,
  type FileTab,
  type SearchTab,
  type Tab
} from './tab-manager/tab-types'

const api: LogEditorApi = window.api

const DEFAULT_CHUNK_SIZE = 512 * 1024
const LARGE_FILE_THRESHOLD_BYTES = 2 * 1024 * 1024
const MAX_RENDERED_LINE_NUMBERS = 400
const MAX_LINE_NUMBER_GUTTER_WIDTH = 160

type PaneId = 'left' | 'right'

type PaneState = {
  id: PaneId
  tabIds: string[]
  activeTabId: string | null
}

type SplitLayoutState = {
  panes: PaneState[]
  focusedPaneId: PaneId
}

type TabContextMenuState = {
  paneId: PaneId
  tabId: string
  x: number
  y: number
} | null

const PRIMARY_PANE_ID: PaneId = 'left'
const SECONDARY_PANE_ID: PaneId = 'right'
const MIN_SPLIT_RATIO = 0.2
const MAX_SPLIT_RATIO = 0.8

const clampSplitRatio = (value: number): number => clamp(value, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO)

const buildViewKey = (paneId: PaneId, tabId: string): string => `${paneId}::${tabId}`

const parseViewKey = (viewKey: string): { paneId: PaneId | null; tabId: string } => {
  const [paneId, tabId] = viewKey.split('::')
  if (paneId === PRIMARY_PANE_ID || paneId === SECONDARY_PANE_ID) {
    return { paneId, tabId }
  }
  return { paneId: null, tabId }
}

const formatBytes = (size: number): string => {
  if (!Number.isFinite(size) || size <= 0) {
    return '0 B'
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)))
  const value = size / Math.pow(1024, exponent)
  const precision = value >= 100 || exponent === 0 ? 0 : 1
  return `${value.toFixed(precision)} ${units[exponent]}`
}

const decodeUriList = (uriList: string | null | undefined): string[] => {
  if (!uriList) {
    return []
  }
  return uriList
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('file://'))
    .map((entry) => {
      try {
        return decodeURI(entry.replace('file://', ''))
      } catch {
        return ''
      }
    })
    .filter((entry) => entry.length > 0)
}

const collectDroppedFilePaths = (transfer: DataTransfer | null): string[] => {
  if (!transfer) {
    return []
  }

  const filePaths = new Set<string>()

  decodeUriList(transfer.getData('text/uri-list')).forEach((path) => {
    if (path) {
      filePaths.add(path)
    }
  })

  const plainText = transfer.getData('text/plain')
  if (plainText) {
    plainText
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith('/'))
      .forEach((entry) => filePaths.add(entry))
  }

  return Array.from(filePaths)
}

const estimateLineNumberGutterWidth = (tab: FileTab | null | undefined): number => {
  if (!tab) {
    return LINE_NUMBER_GUTTER_WIDTH
  }
  const windowEndLine = tab.lineWindowStart + Math.max(0, tab.loadedLineCount - 1)
  const knownLines = Math.max(tab.lineCount, windowEndLine, 1)
  const digits = knownLines > 0 ? Math.floor(Math.log10(knownLines)) + 1 : 1
  const groupingChars = Math.max(0, Math.floor((digits - 1) / 3))
  const estimatedChars = digits + groupingChars
  const extraDigits = Math.max(0, estimatedChars - 4)
  const computedWidth = LINE_NUMBER_GUTTER_WIDTH + extraDigits * 10
  return Math.min(Math.max(computedWidth, LINE_NUMBER_GUTTER_WIDTH), MAX_LINE_NUMBER_GUTTER_WIDTH)
}

type ExtractedTransferPayload = {
  filePaths: string[]
  blobFiles: File[]
}

const resolveDroppedFilePath = (file: File): string | null => {
  const fileWithPath = file as File & { path?: string }
  if (fileWithPath.path && fileWithPath.path.length > 0) {
    return fileWithPath.path
  }
  const getPathForFile = window.electron?.webUtils?.getPathForFile
  if (typeof getPathForFile === 'function') {
    try {
      const resolvedPath = getPathForFile(file)
      if (resolvedPath && resolvedPath.length > 0) {
        return resolvedPath
      }
    } catch (error) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn('[TabManager] getPathForFile failed', error)
      }
    }
  }
  return null
}

const extractTransferPayload = (transfer: DataTransfer | null): ExtractedTransferPayload => {
  if (!transfer) {
    return { filePaths: [], blobFiles: [] }
  }

  const filePaths = new Set<string>(collectDroppedFilePaths(transfer))
  const blobFiles: File[] = []

  Array.from(transfer.files ?? []).forEach((file) => {
    const resolvedPath = resolveDroppedFilePath(file)
    if (resolvedPath) {
      filePaths.add(resolvedPath)
    } else {
      blobFiles.push(file)
    }
  })

  return {
    filePaths: Array.from(filePaths),
    blobFiles
  }
}

const readFilesFromBlobs = async (files: File[]): Promise<OpenedFile[]> => {
  if (!files.length) {
    return []
  }

  const results = await Promise.all(
    files.map(async (file) => {
      try {
        const totalSize = typeof file.size === 'number' ? file.size : 0
        const shouldTruncate = totalSize > LARGE_FILE_THRESHOLD_BYTES
        const chunk = shouldTruncate ? file.slice(0, DEFAULT_CHUNK_SIZE) : file
        const content = await chunk.text()
        const loadedBytes = shouldTruncate ? Math.min(totalSize, DEFAULT_CHUNK_SIZE) : totalSize
        const opened: OpenedFile = {
          filePath: undefined,
          name: file.name || 'Dropped File',
          content,
          size: totalSize || content.length,
          loadedBytes: loadedBytes || content.length,
          isTruncated: shouldTruncate,
          chunkSize: DEFAULT_CHUNK_SIZE
        }
        return opened
      } catch (error) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.error('[TabManager] failed to read dropped file', error)
        }
        return null
      }
    })
  )

  return results.filter((entry): entry is OpenedFile => entry !== null)
}

function TabManager(): React.JSX.Element {
  type LineViewportState = {
    firstLine: number
    offset: number
    visibleLines: number
    lineHeight: number
    paddingTop: number
  }

  type ScrollMetrics = {
    scrollRatio: number
    viewportRatio: number
    canScroll: boolean
  }

  const resolveLineBounds = (value: string, line: number): { start: number; end: number } => {
    const target = Math.max(1, line)
    let startIndex = 0
    let currentLine = 1

    while (currentLine < target && startIndex < value.length) {
      const nextBreak = value.indexOf('\n', startIndex)
      if (nextBreak === -1) {
        startIndex = value.length
        break
      }
      startIndex = nextBreak + 1
      currentLine += 1
    }

    let endIndex = value.indexOf('\n', startIndex)
    if (endIndex === -1) {
      endIndex = value.length
    }
    if (endIndex > startIndex && value.charCodeAt(endIndex - 1) === 13) {
      endIndex -= 1
    }

    return { start: startIndex, end: endIndex }
  }

  const editorRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})
  const highlightRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const initialScrollAppliedRef = useRef<Record<string, boolean>>({})
  const pendingScrollRatioRef = useRef<Record<string, number | null>>({})
  const lineViewportRef = useRef<Record<string, LineViewportState>>({})
  const lineViewportAnimationRef = useRef<Record<string, number | null>>({})
  const [, forceLineViewportRender] = useState(0)
  const autoScrollIntentRef = useRef<Record<string, boolean>>({})
  const defaultLineViewport: LineViewportState = {
    firstLine: 1,
    offset: 0,
    visibleLines: MAX_RENDERED_LINE_NUMBERS,
    lineHeight: 24,
    paddingTop: 0
  }
  const highlightInfoRef = useRef<Record<string, { line: number }>>({})
  const highlightTimeoutRef = useRef<Record<string, number>>({})
  const standardScrollMetricsRef = useRef<Record<string, ScrollMetrics>>({})

  const {
    tabs,
    activeTabId,
    activeTab,
    tabsRef,
    createNewTab,
    openFilesFromPaths,
    openFilesFromContent,
    switchTab,
    closeTab,
    updateTabContent,
    handleSearchResultSelect,
    loadMoreContent,
    jumpToFilePosition,
    ensureLineVisible
  } = useTabsController()

  const [splitLayout, setSplitLayout] = useState<SplitLayoutState>(() => ({
    panes: [
      {
        id: PRIMARY_PANE_ID,
        tabIds: tabs.map((tab) => tab.id),
        activeTabId: activeTabId ?? tabs[0]?.id ?? null
      }
    ],
    focusedPaneId: PRIMARY_PANE_ID
  }))
  const [splitRatio, setSplitRatio] = useState(0.5)
  const [isResizing, setIsResizing] = useState(false)
  const panesContainerRef = useRef<HTMLDivElement | null>(null)
  const resizeStateRef = useRef<{ startX: number; startRatio: number } | null>(null)
  const resizeListenersRef = useRef<{ move?: (event: MouseEvent) => void; up?: (event: MouseEvent) => void }>({})
  const draggingTabRef = useRef<{ tabId: string; sourcePaneId: PaneId } | null>(null)
  const pendingInsertionPaneRef = useRef<PaneId>(PRIMARY_PANE_ID)
  const previousPaneCountRef = useRef<number>(1)
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState>(null)
  const tabMap = useMemo(() => {
    const map = new Map<string, Tab>()
    tabs.forEach((tab) => map.set(tab.id, tab))
    return map
  }, [tabs])

  const closeTabContextMenu = useCallback(() => {
    setTabContextMenu(null)
  }, [])

  useEffect(() => {
    const currentIds = new Set(tabs.map((tab) => tab.id))
    Object.keys(initialScrollAppliedRef.current).forEach((tabId) => {
      if (!currentIds.has(tabId)) {
        delete initialScrollAppliedRef.current[tabId]
      }
    })
  }, [tabs])

  useEffect(() => {
    setSplitLayout((prev) => {
      const tabIds = new Set(tabs.map((tab) => tab.id))
      let panes = prev.panes.map((pane) => {
        const filtered = pane.tabIds.filter((tabId) => tabIds.has(tabId))
        const nextActive = filtered.includes(pane.activeTabId ?? '')
          ? pane.activeTabId
          : filtered[filtered.length - 1] ?? null
        return {
          ...pane,
          tabIds: filtered,
          activeTabId: nextActive
        }
      })
      panes = panes.filter((pane, index) => pane.id !== SECONDARY_PANE_ID || pane.tabIds.length > 0 || index === 0)
      if (!panes.some((pane) => pane.id === PRIMARY_PANE_ID)) {
        panes.unshift({
          id: PRIMARY_PANE_ID,
          tabIds: [],
          activeTabId: null
        })
      }
      const assigned = new Set(panes.flatMap((pane) => pane.tabIds))
      tabs.forEach((tab) => {
        if (!assigned.has(tab.id)) {
          const targetPaneId = panes.some((pane) => pane.id === pendingInsertionPaneRef.current)
            ? pendingInsertionPaneRef.current
            : panes[0].id
          panes = panes.map((pane) => {
            if (pane.id !== targetPaneId) {
              return pane
            }
            return {
              ...pane,
              tabIds: [...pane.tabIds, tab.id],
              activeTabId: tab.id
            }
          })
          assigned.add(tab.id)
        }
      })
      const nextFocused = panes.some((pane) => pane.id === prev.focusedPaneId)
        ? prev.focusedPaneId
        : panes[0]?.id ?? PRIMARY_PANE_ID
      return {
        panes,
        focusedPaneId: nextFocused
      }
    })
  }, [tabs])

  useEffect(() => {
    const currentCount = splitLayout.panes.length
    const previousCount = previousPaneCountRef.current
    if (currentCount <= 1) {
      setSplitRatio(1)
      pendingInsertionPaneRef.current = PRIMARY_PANE_ID
    } else if (previousCount <= 1 && currentCount > 1) {
      setSplitRatio(0.5)
    } else {
      setSplitRatio((current) => clampSplitRatio(current || 0.5))
    }
    previousPaneCountRef.current = currentCount
  }, [splitLayout.panes.length])

  useEffect(() => {
    const validKeys = new Set<string>()
    splitLayout.panes.forEach((pane) => {
      pane.tabIds.forEach((tabId) => {
        validKeys.add(buildViewKey(pane.id, tabId))
      })
    })
    const pruneRecord = <T extends Record<string, unknown>>(record: T) => {
      Object.keys(record).forEach((key) => {
        if (!validKeys.has(key)) {
          delete record[key]
        }
      })
    }
    pruneRecord(editorRefs.current)
    pruneRecord(highlightRefs.current)
    pruneRecord(initialScrollAppliedRef.current)
    pruneRecord(pendingScrollRatioRef.current)
    pruneRecord(lineViewportRef.current)
    pruneRecord(lineViewportAnimationRef.current)
    pruneRecord(autoScrollIntentRef.current)
    pruneRecord(highlightInfoRef.current)
    pruneRecord(highlightTimeoutRef.current)
    pruneRecord(standardScrollMetricsRef.current)
  }, [splitLayout])

  const updateStandardScrollMetrics = useCallback(
    (viewKey: string, textarea: HTMLTextAreaElement | null) => {
      if (!textarea) {
        delete standardScrollMetricsRef.current[viewKey]
        return
      }
      const scrollHeight = textarea.scrollHeight || 0
      const clientHeight = textarea.clientHeight || 0
      const scrollable = Math.max(0, scrollHeight - clientHeight)
      const ratio = scrollable > 0 ? textarea.scrollTop / scrollable : 0
      const viewportRatio = scrollHeight > 0 ? Math.min(1, clientHeight / scrollHeight) : 1
      standardScrollMetricsRef.current[viewKey] = {
        scrollRatio: clamp(ratio, 0, 1),
        viewportRatio,
        canScroll: scrollable > 0
      }
    },
    []
  )

  const scheduleLineViewportUpdate = useCallback(
    (viewKey: string, textarea: HTMLTextAreaElement | null) => {
      if (!textarea) {
        return
      }
      const previousHandle = lineViewportAnimationRef.current[viewKey]
      if (previousHandle) {
        cancelAnimationFrame(previousHandle)
      }
      lineViewportAnimationRef.current[viewKey] = window.requestAnimationFrame(() => {
        const styles = getComputedStyle(textarea)
        const lineHeight = parseFloat(styles.lineHeight || '20') || 20
        const paddingTop = parseFloat(styles.paddingTop || '0') || 0
        const scrollTop = textarea.scrollTop
        const firstLine = Math.max(1, Math.floor((scrollTop + paddingTop) / lineHeight) + 1)
        const offset = scrollTop + paddingTop - (firstLine - 1) * lineHeight
        const visibleLines = Math.max(1, Math.ceil(textarea.clientHeight / lineHeight) + 4)
        lineViewportRef.current[viewKey] = {
          firstLine,
          offset,
          visibleLines,
          lineHeight,
          paddingTop
        }
        updateStandardScrollMetrics(viewKey, textarea)
        forceLineViewportRender((value) => value + 1)
        lineViewportAnimationRef.current[viewKey] = null
      })
    },
    [updateStandardScrollMetrics]
  )

  const focusLine = useCallback(
    (paneId: PaneId, tabId: string, line: number, column = 1) => {
      const viewKey = buildViewKey(paneId, tabId)
      const textarea = editorRefs.current[viewKey]
      const overlay = highlightRefs.current[viewKey]
      if (!textarea || !overlay) {
        return
      }

      const tabRecord = tabsRef.current.find(
        (tab): tab is FileTab => tab.id === tabId && isFileTab(tab)
      )
      const totalLines = tabRecord?.loadedLineCount ?? 1
      const windowStart = tabRecord?.isWindowed ? tabRecord.lineWindowStart : 1
      const relativeLine = tabRecord?.isWindowed ? line - windowStart + 1 : line
      const targetLine = clamp(relativeLine, 1, Math.max(1, totalLines))

      const { start, end } = resolveLineBounds(textarea.value, targetLine)
      const lineLength = Math.max(0, end - start)
      const safeColumn = clamp(column, 1, lineLength + 1)
      const selectionStart = Math.min(textarea.value.length, start + safeColumn - 1)

      textarea.focus()
      textarea.setSelectionRange(selectionStart, selectionStart)

      const styles = getComputedStyle(textarea)
      const lineHeight = parseFloat(styles.lineHeight || '20')
      const paddingTop = parseFloat(styles.paddingTop || '0')
      const visibleArea = textarea.clientHeight
      const desiredScrollTop = Math.max(0, paddingTop + (targetLine - 1) * lineHeight - visibleArea / 2)

      textarea.scrollTop = desiredScrollTop
      scheduleLineViewportUpdate(viewKey, textarea)

      const paintHighlight = (): void => {
        const top = paddingTop + (targetLine - 1) * lineHeight - textarea.scrollTop
        overlay.style.top = `${Math.max(top, 0)}px`
        overlay.style.height = `${lineHeight}px`
        overlay.style.opacity = '1'
        overlay.style.transition = 'opacity 0.3s ease'
      }

      paintHighlight()
      requestAnimationFrame(paintHighlight)

      highlightInfoRef.current[viewKey] = { line: targetLine }
      if (highlightTimeoutRef.current[viewKey]) {
        window.clearTimeout(highlightTimeoutRef.current[viewKey])
      }
      highlightTimeoutRef.current[viewKey] = window.setTimeout(() => {
        overlay.style.opacity = '0'
        delete highlightInfoRef.current[viewKey]
        delete highlightTimeoutRef.current[viewKey]
      }, 2000)
    },
    [scheduleLineViewportUpdate, tabsRef]
  )

  useEffect(() => {
    if (!activeTabId) {
      return
    }
    const activeTabRecord = tabsRef.current.find((tab) => tab.id === activeTabId)
    if (!activeTabRecord || !isFileTab(activeTabRecord)) {
      return
    }
    const paneId = splitLayout.focusedPaneId
    const viewKey = buildViewKey(paneId, activeTabRecord.id)
    const textarea = editorRefs.current[viewKey]
    const overlay = highlightRefs.current[viewKey]
    if (!textarea || !overlay) {
      return
    }

    const updateOverlayPosition = (): void => {
      scheduleLineViewportUpdate(viewKey, textarea)
      const highlight = highlightInfoRef.current[viewKey]
      if (!highlight) {
        overlay.style.opacity = '0'
        return
      }
      const styles = getComputedStyle(textarea)
      const lineHeight = parseFloat(styles.lineHeight || '20')
      const paddingTop = parseFloat(styles.paddingTop || '0')
      const top = paddingTop + (highlight.line - 1) * lineHeight - textarea.scrollTop
      overlay.style.top = `${Math.max(top, 0)}px`
      overlay.style.height = `${lineHeight}px`
    }

    updateOverlayPosition()
    textarea.addEventListener('scroll', updateOverlayPosition)

    return () => {
      textarea.removeEventListener('scroll', updateOverlayPosition)
    }
  }, [activeTabId, tabsRef, scheduleLineViewportUpdate, splitLayout.focusedPaneId])
  useEffect(() => {
    if (!activeTab || !isFileTab(activeTab)) {
      return
    }
    const viewKey = buildViewKey(splitLayout.focusedPaneId, activeTab.id)
    const textarea = editorRefs.current[viewKey]
    if (textarea) {
      scheduleLineViewportUpdate(viewKey, textarea)
    }
  }, [activeTab, scheduleLineViewportUpdate, splitLayout.focusedPaneId])

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      Object.entries(pendingScrollRatioRef.current).forEach(([viewKey, targetRatio]) => {
        if (targetRatio == null) {
          return
        }
        const { tabId } = parseViewKey(viewKey)
        const tabRecord = tabsRef.current.find(
          (tab): tab is FileTab => tab.id === tabId && isFileTab(tab)
        )
        if (!tabRecord) {
          pendingScrollRatioRef.current[viewKey] = null
          return
        }
        const textarea = editorRefs.current[viewKey]
        if (!textarea) {
          return
        }
        const totalLines = Math.max(
          tabRecord.lineCount ?? 0,
          tabRecord.lineWindowStart + Math.max(tabRecord.loadedLineCount - 1, 0),
          1
        )
        if (totalLines <= 0 && tabRecord.size <= 0) {
          pendingScrollRatioRef.current[viewKey] = null
          return
        }
        const startRatio =
          tabRecord.size > 0
            ? tabRecord.loadedRange.start / tabRecord.size
            : (tabRecord.lineWindowStart - 1) / totalLines
        const chunkSpan =
          tabRecord.size > 0 && tabRecord.loadedRange.end > tabRecord.loadedRange.start
            ? (tabRecord.loadedRange.end - tabRecord.loadedRange.start) / tabRecord.size
            : tabRecord.loadedLineCount / totalLines
        if (chunkSpan <= 0) {
          pendingScrollRatioRef.current[viewKey] = null
          return
        }
        if (targetRatio < startRatio || targetRatio > startRatio + chunkSpan) {
          return
        }
        const relative = clamp((targetRatio - startRatio) / chunkSpan, 0, 1)
        const scrollable = textarea.scrollHeight - textarea.clientHeight
        if (scrollable <= 0) {
          pendingScrollRatioRef.current[viewKey] = null
          return
        }
        textarea.scrollTop = relative * scrollable
        pendingScrollRatioRef.current[viewKey] = null
        scheduleLineViewportUpdate(viewKey, textarea)
      })
    })
    return () => {
      window.cancelAnimationFrame(raf)
    }
  }, [scheduleLineViewportUpdate, splitLayout, tabsRef])

  useEffect(() => {
    return () => {
      Object.values(highlightTimeoutRef.current).forEach((timeoutId) => {
        window.clearTimeout(timeoutId)
      })
      Object.values(lineViewportAnimationRef.current).forEach((handle) => {
        if (handle) {
          cancelAnimationFrame(handle)
        }
      })
      const { move, up } = resizeListenersRef.current
      if (move) {
        window.removeEventListener('mousemove', move)
      }
      if (up) {
        window.removeEventListener('mouseup', up)
      }
    }
  }, [])

  useEffect(() => {
    Object.entries(autoScrollIntentRef.current).forEach(([viewKey, intent]) => {
      if (!intent) {
        return
      }
      const { tabId } = parseViewKey(viewKey)
      const fileTab = tabs.find((tab): tab is FileTab => tab.id === tabId && isFileTab(tab))
      if (!fileTab || fileTab.isLoadingMore) {
        return
      }
      const textarea = editorRefs.current[viewKey]
      if (textarea) {
        textarea.scrollTop = textarea.scrollHeight - textarea.clientHeight
        scheduleLineViewportUpdate(viewKey, textarea)
      }
      autoScrollIntentRef.current[viewKey] = false
    })
  }, [scheduleLineViewportUpdate, tabs])

  useEffect(() => {
    if (!tabContextMenu) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setTabContextMenu(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [tabContextMenu])

  const createExternalDragOverHandler = useCallback(
    (paneId?: PaneId) => (event: ReactDragEvent) => {
      if (draggingTabRef.current) {
        return
      }
      closeTabContextMenu()
      event.preventDefault()
      event.stopPropagation()
      pendingInsertionPaneRef.current = paneId ?? pendingInsertionPaneRef.current
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy'
      }
    },
    [closeTabContextMenu]
  )

  const createExternalDropHandler = useCallback(
    (paneId?: PaneId) => (event: ReactDragEvent) => {
      if (draggingTabRef.current) {
        return
      }
      closeTabContextMenu()
      event.preventDefault()
      event.stopPropagation()
      if (paneId) {
        pendingInsertionPaneRef.current = paneId
      }
      const transfer = event.nativeEvent?.dataTransfer ?? event.dataTransfer ?? null
      const { filePaths, blobFiles } = extractTransferPayload(transfer)

      if (filePaths.length) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.log('[TabManager] drop received (paths)', filePaths)
        }
        void openFilesFromPaths(filePaths)
      }

      if (blobFiles.length) {
        void (async () => {
          const fallbackFiles = await readFilesFromBlobs(blobFiles)
          if (fallbackFiles.length) {
            if (import.meta.env.DEV) {
              // eslint-disable-next-line no-console
              console.log('[TabManager] drop received (blob)', fallbackFiles.map((file) => file.name))
            }
            openFilesFromContent(fallbackFiles)
            return
          }
          if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.warn('[TabManager] drop ignored (blob read failed)', {
              names: blobFiles.map((file) => file.name)
            })
          }
        })()
      }

      if (!filePaths.length && !blobFiles.length && import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn('[TabManager] drop ignored (no readable files)', {
          types: transfer?.types
        })
      }
    },
    [closeTabContextMenu, openFilesFromContent, openFilesFromPaths]
  )

  const handleStandardSeek = useCallback(
    (viewKey: string, ratio: number) => {
      const textarea = editorRefs.current[viewKey]
      if (!textarea) {
        return
      }
      const scrollHeight = textarea.scrollHeight
      const clientHeight = textarea.clientHeight
      const scrollable = scrollHeight - clientHeight
      if (!Number.isFinite(scrollable) || scrollable <= 0) {
        return
      }
      textarea.scrollTop = clamp(ratio, 0, 1) * scrollable
      scheduleLineViewportUpdate(viewKey, textarea)
    },
    [scheduleLineViewportUpdate]
  )

  const handleFileScroll = useCallback(
    (tab: FileTab, textarea: HTMLTextAreaElement, viewKey: string) => {
      scheduleLineViewportUpdate(viewKey, textarea)
      if (tab.isWindowed) {
        if (tab.isLoadingMore || tab.isDirty) {
          return
        }
        const scrollable = textarea.scrollHeight - textarea.clientHeight
        if (scrollable <= 0) {
          return
        }
        const scrollRatio = textarea.scrollTop / scrollable
        if (scrollRatio > 0.95 && tab.loadedRange.end < tab.size) {
          void loadMoreContent(tab.id, 'forward').catch((error) => {
            if (import.meta.env.DEV) {
              // eslint-disable-next-line no-console
              console.error('[TabManager] window shift forward failed', error)
            }
          })
        } else if (scrollRatio < 0.05 && tab.loadedRange.start > 0) {
          void loadMoreContent(tab.id, 'backward').catch((error) => {
            if (import.meta.env.DEV) {
              // eslint-disable-next-line no-console
              console.error('[TabManager] window shift backward failed', error)
            }
          })
        }
        return
      }
      if (!tab.isTruncated || tab.isLoadingMore) {
        return
      }
      const totalLines = Math.max(tab.lineCount || tab.loadedLineCount || 1, 1)
      const loadedRatio = Math.min(1, tab.loadedLineCount / totalLines)
      const scrollable = textarea.scrollHeight - textarea.clientHeight
      if (scrollable <= 0) {
        return
      }
      const scrollTop = textarea.scrollTop
      const scrollRatio = scrollTop / scrollable
      const targetLine = Math.max(1, Math.floor(scrollRatio * totalLines))
      const targetRatio = targetLine / totalLines
      if (targetRatio >= loadedRatio - 0.02) {
        autoScrollIntentRef.current[viewKey] = scrollRatio > 0.9
        void loadMoreContent(tab.id, 'forward').catch((error) => {
          if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.error('[TabManager] auto load failed', error)
          }
        })
      }
    },
    [loadMoreContent, scheduleLineViewportUpdate]
  )

  const renderWelcomeContent = useCallback(
    () => (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-slate-500">
        <h1 className="text-3xl font-semibold text-slate-800">Welcome to LogEditor</h1>
        <p className="max-w-md text-sm text-slate-500">
          Use the File menu to create a blank log or open an existing one. When you are ready to search
          across files, open the Search window from the menu.
        </p>
      </div>
    ),
    []
  )

  const focusPane = useCallback((paneId: PaneId) => {
    pendingInsertionPaneRef.current = paneId
    setSplitLayout((prev) => {
      if (prev.focusedPaneId === paneId || !prev.panes.some((pane) => pane.id === paneId)) {
        return prev
      }
      return {
        ...prev,
        focusedPaneId: paneId
      }
    })
  }, [])

  const ensurePaneExists = useCallback((paneId: PaneId) => {
    if (paneId === PRIMARY_PANE_ID) {
      return
    }
    let created = false
    setSplitLayout((prev) => {
      if (prev.panes.some((pane) => pane.id === paneId)) {
        return prev
      }
      created = true
      const primary =
        prev.panes.find((pane) => pane.id === PRIMARY_PANE_ID) ?? {
          id: PRIMARY_PANE_ID,
          tabIds: [],
          activeTabId: null
        }
      return {
        panes: [
          primary,
          {
            id: paneId,
            tabIds: [],
            activeTabId: null
          }
        ],
        focusedPaneId: prev.focusedPaneId
      }
    })
    if (created) {
      setSplitRatio(0.5)
    }
  }, [])

  const activateTabInPane = useCallback(
    (paneId: PaneId, tabId: string, options?: { focus?: boolean }) => {
      const shouldFocus = options?.focus ?? true
      ensurePaneExists(paneId)
      setSplitLayout((prev) => {
        if (!prev.panes.some((pane) => pane.id === paneId)) {
          return prev
        }
        const panes = prev.panes.map((pane) => {
          if (pane.id !== paneId) {
            return pane
          }
          const hasTab = pane.tabIds.includes(tabId)
          return {
            ...pane,
            tabIds: hasTab ? pane.tabIds : [...pane.tabIds, tabId],
            activeTabId: tabId
          }
        })
        return {
          panes,
          focusedPaneId: shouldFocus ? paneId : prev.focusedPaneId
        }
      })
      pendingInsertionPaneRef.current = paneId
      if (shouldFocus) {
        switchTab(tabId)
      }
    },
    [ensurePaneExists, switchTab]
  )

  const moveTabBetweenPanes = useCallback(
    (tabId: string, sourcePaneId: PaneId, targetPaneId: PaneId, targetIndex?: number) => {
      ensurePaneExists(targetPaneId)
      setSplitLayout((prev) => {
        if (!prev.panes.some((pane) => pane.id === targetPaneId)) {
          return prev
        }
        const updated = prev.panes.map((pane) => {
          if (pane.id === sourcePaneId) {
            const filtered = pane.tabIds.filter((id) => id !== tabId)
            const nextActive =
              pane.activeTabId === tabId ? filtered[filtered.length - 1] ?? null : pane.activeTabId
            return { ...pane, tabIds: filtered, activeTabId: nextActive }
          }
          return pane
        })
        const nextPanes = updated.map((pane) => {
          if (pane.id !== targetPaneId) {
            return pane
          }
          const existing = pane.tabIds.filter((id) => id !== tabId)
          const insertIndex =
            typeof targetIndex === 'number'
              ? clamp(targetIndex, 0, existing.length)
              : existing.length
          existing.splice(insertIndex, 0, tabId)
          return {
            ...pane,
            tabIds: existing,
            activeTabId: tabId
          }
        })
        const collapsed = nextPanes.filter(
          (pane) => pane.id !== SECONDARY_PANE_ID || pane.tabIds.length > 0
        )
        const fallback: PaneState = collapsed.find((pane) => pane.id === PRIMARY_PANE_ID) ?? {
          id: PRIMARY_PANE_ID,
          tabIds: [],
          activeTabId: null
        }
        const normalized = collapsed.length ? collapsed : [fallback]
        return {
          panes: normalized,
          focusedPaneId: targetPaneId
        }
      })
      pendingInsertionPaneRef.current = targetPaneId
      switchTab(tabId)
    },
    [ensurePaneExists, switchTab]
  )

  const removeTabFromPane = useCallback((paneId: PaneId, tabId: string) => {
    setSplitLayout((prev) => {
      const panes = prev.panes.map((pane) => {
        if (pane.id !== paneId) {
          return pane
        }
        const filtered = pane.tabIds.filter((id) => id !== tabId)
        const nextActive =
          pane.activeTabId === tabId ? filtered[filtered.length - 1] ?? null : pane.activeTabId
        return {
          ...pane,
          tabIds: filtered,
          activeTabId: nextActive
        }
      })
      const collapsed = panes.filter(
        (pane) => pane.id !== SECONDARY_PANE_ID || pane.tabIds.length > 0
      )
      const normalized = collapsed.length
        ? collapsed
        : [
            {
              id: PRIMARY_PANE_ID,
              tabIds: [],
              activeTabId: null
            }
          ]
      const nextFocused =
        normalized.some((pane) => pane.id === prev.focusedPaneId) && prev.focusedPaneId !== paneId
          ? prev.focusedPaneId
          : normalized[0]?.id ?? PRIMARY_PANE_ID
      return {
        panes: normalized,
        focusedPaneId: nextFocused
      }
    })
  }, [])

  const splitTabToRight = useCallback(
    (tabId: string) => {
      if (!tabMap.has(tabId)) {
        return
      }
      activateTabInPane(SECONDARY_PANE_ID, tabId, { focus: true })
    },
    [activateTabInPane, tabMap]
  )

  const splitActiveTabToRight = useCallback(() => {
    const focusedPane =
      splitLayout.panes.find((pane) => pane.id === splitLayout.focusedPaneId) ??
      splitLayout.panes[0]
    const targetTabId =
      focusedPane?.activeTabId ?? activeTabId ?? tabs[0]?.id ?? null
    if (!targetTabId) {
      return
    }
    splitTabToRight(targetTabId)
  }, [activeTabId, splitLayout.focusedPaneId, splitLayout.panes, splitTabToRight, tabs])

  const getPaneTabIds = useCallback(
    (paneId: PaneId): string[] => splitLayout.panes.find((pane) => pane.id === paneId)?.tabIds ?? [],
    [splitLayout.panes]
  )

  const getOppositePaneId = useCallback(
    (paneId: PaneId): PaneId | null => {
      if (splitLayout.panes.length < 2) {
        return null
      }
      const other = splitLayout.panes.find((pane) => pane.id !== paneId)
      return other?.id ?? null
    },
    [splitLayout.panes]
  )

  const handleTabDragStart = useCallback(
    (paneId: PaneId, tabId: string) => (event: ReactDragEvent<HTMLButtonElement>) => {
      closeTabContextMenu()
      draggingTabRef.current = { tabId, sourcePaneId: paneId }
      event.dataTransfer?.setData('text/plain', tabId)
      event.dataTransfer?.setDragImage(event.currentTarget, 0, 0)
    },
    [closeTabContextMenu]
  )

  const handleTabDragEnd = useCallback(() => {
    draggingTabRef.current = null
  }, [])

  const handleTabDragOver = useCallback(
    (paneId: PaneId) => (event: ReactDragEvent) => {
      if (!draggingTabRef.current) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      pendingInsertionPaneRef.current = paneId
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move'
      }
    },
    []
  )

  const handleTabDropOnTab = useCallback(
    (paneId: PaneId, targetTabId: string) => (event: ReactDragEvent) => {
      const dragging = draggingTabRef.current
      if (!dragging) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      draggingTabRef.current = null
      const currentTabs = getPaneTabIds(paneId)
      const targetIndex = currentTabs.indexOf(targetTabId)
      moveTabBetweenPanes(dragging.tabId, dragging.sourcePaneId, paneId, targetIndex)
    },
    [getPaneTabIds, moveTabBetweenPanes]
  )

  const handleTabBarDrop = useCallback(
    (paneId: PaneId) => (event: ReactDragEvent) => {
      const dragging = draggingTabRef.current
      if (!dragging) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      draggingTabRef.current = null
      moveTabBetweenPanes(dragging.tabId, dragging.sourcePaneId, paneId)
    },
    [moveTabBetweenPanes]
  )

  const handleCloseView = useCallback(
    (paneId: PaneId, tabId: string) => {
      const existsElsewhere = splitLayout.panes.some(
        (pane) => pane.id !== paneId && pane.tabIds.includes(tabId)
      )
      removeTabFromPane(paneId, tabId)
      if (!existsElsewhere) {
        closeTab(tabId)
      }
    },
    [closeTab, removeTabFromPane, splitLayout.panes]
  )

  const handleTabContextMenu = useCallback(
    (paneId: PaneId, tabId: string) => (event: ReactMouseEvent) => {
      event.preventDefault()
      closeTabContextMenu()
      focusPane(paneId)
      setTabContextMenu({
        paneId,
        tabId,
        x: event.clientX,
        y: event.clientY
      })
    },
    [closeTabContextMenu, focusPane]
  )

  const handleContextMenuSplit = useCallback(() => {
    if (!tabContextMenu) {
      return
    }
    splitTabToRight(tabContextMenu.tabId)
    closeTabContextMenu()
  }, [closeTabContextMenu, splitTabToRight, tabContextMenu])

  const handleContextMenuClose = useCallback(() => {
    if (!tabContextMenu) {
      return
    }
    handleCloseView(tabContextMenu.paneId, tabContextMenu.tabId)
    closeTabContextMenu()
  }, [closeTabContextMenu, handleCloseView, tabContextMenu])

  const closeFocusedPaneTab = useCallback(() => {
    const targetPane =
      splitLayout.panes.find((pane) => pane.id === splitLayout.focusedPaneId) ??
      splitLayout.panes[0]
    if (!targetPane) {
      return
    }
    const targetTabId =
      targetPane.activeTabId ?? targetPane.tabIds[targetPane.tabIds.length - 1]
    if (!targetTabId) {
      return
    }
    handleCloseView(targetPane.id, targetTabId)
  }, [handleCloseView, splitLayout])

  const handleResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!panesContainerRef.current || splitLayout.panes.length < 2) {
        return
      }
      closeTabContextMenu()
      event.preventDefault()
      setIsResizing(true)
      resizeStateRef.current = { startX: event.clientX, startRatio: splitRatio }
      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!resizeStateRef.current || !panesContainerRef.current) {
          return
        }
        const bounds = panesContainerRef.current.getBoundingClientRect()
        if (bounds.width <= 0) {
          return
        }
        const deltaRatio = (moveEvent.clientX - resizeStateRef.current.startX) / bounds.width
        const nextRatio = clampSplitRatio(resizeStateRef.current.startRatio + deltaRatio)
        setSplitRatio(nextRatio)
      }
      const handleMouseUp = () => {
        setIsResizing(false)
        resizeStateRef.current = null
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
        resizeListenersRef.current = {}
      }
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      resizeListenersRef.current = { move: handleMouseMove, up: handleMouseUp }
    },
    [closeTabContextMenu, splitLayout.panes.length, splitRatio]
  )

  useEffect(() => {
    const disposers = [
      api.onMenuSplitRight(() => splitActiveTabToRight()),
      api.onMenuCloseTab(() => closeFocusedPaneTab())
    ]
    return () => {
      disposers.forEach((dispose) => dispose())
    }
  }, [closeFocusedPaneTab, splitActiveTabToRight])

  useEffect(() => {
    const disposer = api.onSearchNavigate((payload) => {
      const exists = tabsRef.current.some((tab) => tab.id === payload.tabId)
      if (!exists) {
        return
      }
      const paneId = splitLayout.focusedPaneId
      activateTabInPane(paneId, payload.tabId, { focus: true })
      const ensureAndFocus = async () => {
        await ensureLineVisible(payload.tabId, payload.line)
        requestAnimationFrame(() => focusLine(paneId, payload.tabId, payload.line, payload.column))
      }
      void ensureAndFocus()
    })

    return () => {
      disposer()
    }
  }, [activateTabInPane, ensureLineVisible, focusLine, splitLayout.focusedPaneId, tabsRef])

  const handleSelectSearchMatch = useCallback(
    (paneId: PaneId, result: SearchResultItem, match: SearchMatch) => {
      const targetPaneId =
        getOppositePaneId(paneId) ?? (paneId === PRIMARY_PANE_ID ? SECONDARY_PANE_ID : paneId)
      handleSearchResultSelect(result, match)
      activateTabInPane(targetPaneId, result.tabId, { focus: true })
      const ensureLoaded = async () => {
        await ensureLineVisible(result.tabId, match.line)
        requestAnimationFrame(() => focusLine(targetPaneId, result.tabId, match.line, match.column))
      }
      void ensureLoaded()
    },
    [activateTabInPane, ensureLineVisible, focusLine, getOppositePaneId, handleSearchResultSelect]
  )

  const renderSearchContent = useCallback(
    (paneId: PaneId, tab: SearchTab) => (
      <SearchResultsPanel
        tab={tab}
        onSelectMatch={(result, match) => handleSelectSearchMatch(paneId, result, match)}
      />
    ),
    [handleSelectSearchMatch]
  )

  const renderPaneContent = (paneId: PaneId, tab: Tab | null): React.ReactNode => {
    if (!tab) {
      return (
        <div className="flex h-full items-center justify-center border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-400">
          Drop a tab here or use the + button to create one.
        </div>
      )
    }
    if (isFileTab(tab)) {
      const viewKey = buildViewKey(paneId, tab.id)
      const loadedBytes = Math.max(0, tab.loadedRange.end - tab.loadedRange.start)
      const totalBytes = tab.size > 0 ? tab.size : loadedBytes
      const viewport = lineViewportRef.current[viewKey] ?? defaultLineViewport
      const totalLines = Math.max(tab.loadedLineCount, 1)
      const safeFirstLine = Math.min(Math.max(1, viewport.firstLine), totalLines)
      const chunkRemaining = Math.max(1, totalLines - safeFirstLine + 1)
      const windowStartLine = Math.max(1, tab.lineWindowStart)
      const knownLineCount = tab.lineCount > 0 ? tab.lineCount : 0
      const globalFirstLine = windowStartLine + safeFirstLine - 1
      const fileRemaining =
        knownLineCount > 0 ? Math.max(1, knownLineCount - globalFirstLine + 1) : chunkRemaining
      const effectiveRemaining = Math.max(1, Math.min(chunkRemaining, fileRemaining))
      const lineRenderCount = Math.max(
        1,
        Math.min(viewport.visibleLines, effectiveRemaining, MAX_RENDERED_LINE_NUMBERS)
      )
      const lineNumbers = Array.from({ length: lineRenderCount }, (_, index) => safeFirstLine + index)
      const displayLineNumbers = lineNumbers.map((lineNumber) => {
        const globalLineNumber = windowStartLine + lineNumber - 1
        if (knownLineCount > 0) {
          return Math.max(1, Math.min(globalLineNumber, knownLineCount))
        }
        return Math.max(1, globalLineNumber)
      })
      const disableWindowShift = tab.isLoadingMore || tab.isDirty
      const lineNumberGutterWidth = estimateLineNumberGutterWidth(tab)
      const chunkStartRatio =
        tab.size > 0 ? Math.max(0, tab.loadedRange.start / tab.size) : 0
      const chunkEndRatio =
        tab.size > 0 ? Math.min(1, tab.loadedRange.end / tab.size) : 1
      const scrollMetrics = standardScrollMetricsRef.current[viewKey]
      const standardScrollStart = scrollMetrics?.scrollRatio ?? 0
      const standardScrollEnd = standardScrollStart + (scrollMetrics?.viewportRatio ?? 1)
      const standardScrollDisabled = scrollMetrics ? !scrollMetrics.canScroll : false
      const handleWindowSeek = (nextRatio: number) => {
        if (disableWindowShift) {
          return
        }
        const clamped = clamp(nextRatio, 0, 1)
        pendingScrollRatioRef.current[viewKey] = clamped
        void jumpToFilePosition(tab.id, clamped).catch((error) => {
          if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.error('[TabManager] window jump failed', error)
          }
          pendingScrollRatioRef.current[viewKey] = null
        })
      }
      return (
        <div className="relative flex h-full min-h-0 flex-col">
          {tab.isWindowed ? null : tab.isReadOnly ? (
            <div className="flex items-center justify-between gap-4 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
              <div className="flex flex-col">
                <span className="font-semibold">Large file preview (read-only)</span>
                <span className="text-amber-700">
                  Loaded {formatBytes(loadedBytes)} of {formatBytes(totalBytes)} · lines{' '}
                  {tab.loadedLineCount.toLocaleString()} / {tab.lineCount?.toLocaleString() ?? '—'} · chunk size{' '}
                  {formatBytes(tab.chunkSize)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {tab.isTruncated ? (
                  <button
                    type="button"
                    className="rounded border border-amber-400 px-3 py-1 text-xs font-semibold text-amber-900 transition hover:border-amber-500 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={tab.isLoadingMore}
                    onClick={() => {
                      void loadMoreContent(tab.id).catch((error) => {
                        if (import.meta.env.DEV) {
                          // eslint-disable-next-line no-console
                          console.error('[TabManager] load more failed', error)
                        }
                      })
                    }}
                  >
                    {tab.isLoadingMore ? 'Loading…' : 'Load next chunk'}
                  </button>
                ) : (
                  <span className="text-emerald-700">Fully loaded</span>
                )}
              </div>
            </div>
          ) : null}
          <div className="relative flex flex-1 min-h-0">
            <div className="relative h-full shrink-0 overflow-hidden border-r border-slate-200 bg-slate-100/80">
              <div
                className="px-3 py-0 text-right font-mono text-xs text-slate-400 will-change-transform"
                style={{
                  width: `${lineNumberGutterWidth}px`,
                  transform: `translateY(-${viewport.offset}px)`,
                  paddingTop: `${viewport.paddingTop}px`
                }}
              >
                {displayLineNumbers.map((globalLineNumber) => (
                  <span
                    key={`${tab.id}-line-${globalLineNumber}`}
                    className="block"
                    style={{
                      height: `${viewport.lineHeight}px`,
                      lineHeight: `${viewport.lineHeight}px`
                    }}
                  >
                    {globalLineNumber.toLocaleString()}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex flex-1 min-h-0 items-stretch">
              <div className="relative flex-1">
                <textarea
                  ref={(el) => {
                    editorRefs.current[viewKey] = el
                    if (el && !initialScrollAppliedRef.current[viewKey]) {
                      el.scrollTop = 0
                      initialScrollAppliedRef.current[viewKey] = true
                    }
                    updateStandardScrollMetrics(viewKey, el)
                    scheduleLineViewportUpdate(viewKey, el)
                  }}
                  value={tab.content}
                  onChange={(event) => updateTabContent(tab.id, event.target.value)}
                  onDragOver={createExternalDragOverHandler(paneId)}
                  onDrop={createExternalDropHandler(paneId)}
                  onScroll={(event) => handleFileScroll(tab, event.currentTarget, viewKey)}
                  readOnly={tab.isReadOnly}
                  className={`editor-scrollbar h-full w-full resize-none p-0 font-mono text-sm leading-6 outline-none ${
                    tab.isReadOnly ? 'bg-slate-50 text-slate-700' : 'bg-transparent text-slate-900'
                  }`}
                  spellCheck={false}
                />
                <div
                  ref={(el) => {
                    highlightRefs.current[viewKey] = el
                  }}
                  className="pointer-events-none absolute inset-0 bg-amber-200/60 opacity-0 transition-opacity"
                />
              </div>
              <div className="ml-2 flex h-full items-stretch gap-2">
                <Minimap
                  content={tab.content}
                  startRatio={tab.isWindowed ? chunkStartRatio : standardScrollStart}
                  endRatio={tab.isWindowed ? chunkEndRatio : standardScrollEnd}
                  disabled={tab.isWindowed ? disableWindowShift : standardScrollDisabled}
                  onSeek={
                    tab.isWindowed ? handleWindowSeek : (ratio) => handleStandardSeek(viewKey, ratio)
                  }
                  className="h-full w-16"
                />
                {tab.isWindowed ? (
                  <WindowedScrollBar
                    startRatio={chunkStartRatio}
                    endRatio={chunkEndRatio}
                    disabled={disableWindowShift}
                    onSeek={handleWindowSeek}
                    className="h-full"
                  />
                ) : (
                  <WindowedScrollBar
                    startRatio={standardScrollStart}
                    endRatio={standardScrollEnd}
                    disabled={standardScrollDisabled}
                    onSeek={(ratio) => handleStandardSeek(viewKey, ratio)}
                    className="h-full"
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      )
    }
    if (isWelcomeTab(tab)) {
      return renderWelcomeContent()
    }
    if (isSearchTab(tab)) {
      return renderSearchContent(paneId, tab)
    }
    return null
  }

  const paneCount = splitLayout.panes.length
  const getPaneWidth = (index: number): number => {
    if (paneCount <= 1) {
      return 1
    }
    return index === 0 ? splitRatio : 1 - splitRatio
  }

  const renderPane = (pane: PaneState, index: number): React.ReactNode => {
    const width = getPaneWidth(index)
    const activeTabForPane = pane.activeTabId ? tabMap.get(pane.activeTabId) ?? null : null
    const paneIsFocused = splitLayout.focusedPaneId === pane.id
    const tabDragOverHandler = handleTabDragOver(pane.id)
    const tabBarDropHandler = handleTabBarDrop(pane.id)
    const externalDragOver = createExternalDragOverHandler(pane.id)
    const externalDrop = createExternalDropHandler(pane.id)
    return (
      <div
        key={pane.id}
        className={`flex h-full flex-col border-l border-slate-200 bg-white ${paneIsFocused ? 'ring-1 ring-sky-400' : 'ring-1 ring-transparent'}`}
        style={{ width: `${width * 100}%` }}
        onPointerDown={() => focusPane(pane.id)}
        onDragOver={externalDragOver}
        onDrop={externalDrop}
      >
        <nav
          className="flex min-h-[40px] items-center gap-1 border-b border-slate-200 bg-slate-100 px-2"
          onDoubleClick={(event) => {
            const target = event.target as HTMLElement | null
            if (!target?.closest('button')) {
              closeTabContextMenu()
              pendingInsertionPaneRef.current = pane.id
              focusPane(pane.id)
              createNewTab()
            }
          }}
          onDragOver={tabDragOverHandler}
          onDrop={tabBarDropHandler}
        >
          {pane.tabIds.map((tabId) => {
            const tab = tabMap.get(tabId)
            if (!tab) {
              return null
            }
            const isActiveInPane = pane.activeTabId === tabId
            const dragStartHandler = handleTabDragStart(pane.id, tab.id)
            const dropOnTabHandler = handleTabDropOnTab(pane.id, tab.id)
            const contextMenuHandler = handleTabContextMenu(pane.id, tab.id)
            return (
              <button
                key={`${pane.id}-${tab.id}`}
                type="button"
                draggable
                onDragStart={dragStartHandler}
                onDragEnd={handleTabDragEnd}
                onDrop={dropOnTabHandler}
                onContextMenu={contextMenuHandler}
                onClick={() => activateTabInPane(pane.id, tab.id)}
                className={`group flex h-9 items-center gap-2 rounded px-3 text-sm transition ${
                  isActiveInPane
                    ? 'bg-white text-sky-700 shadow-sm'
                    : 'bg-slate-200/70 text-slate-500 hover:bg-slate-100 hover:text-slate-700'
                }`}
              >
                <span className="max-w-[160px] truncate">{tab.title}</span>
                {isFileTab(tab) && tab.isDirty ? (
                  <span className="size-2 rounded-full bg-rose-500" />
                ) : null}
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Close ${tab.title}`}
                  className="ml-1 rounded px-1 text-xs text-slate-400 transition hover:bg-slate-200 hover:text-slate-900"
                  onClick={(event) => {
                    event.stopPropagation()
                    closeTabContextMenu()
                    handleCloseView(pane.id, tab.id)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      event.stopPropagation()
                      closeTabContextMenu()
                      handleCloseView(pane.id, tab.id)
                    }
                  }}
                >
                  ×
                </span>
              </button>
            )
          })}
          <button
            type="button"
            className="ml-auto rounded border border-slate-300 px-2 text-sm text-slate-600 transition hover:border-sky-400 hover:text-sky-600"
            onClick={() => {
              closeTabContextMenu()
              pendingInsertionPaneRef.current = pane.id
              focusPane(pane.id)
              createNewTab()
            }}
          >
            +
          </button>
        </nav>
        <div className="flex-1 overflow-hidden">
          {renderPaneContent(pane.id, activeTabForPane ?? null)}
        </div>
      </div>
    )
  }

  return (
    <div
      className="relative flex h-full flex-col bg-slate-50 text-slate-900"
      onDragOver={createExternalDragOverHandler()}
      onDrop={createExternalDropHandler()}
    >
      <main ref={panesContainerRef} className="flex flex-1 overflow-hidden bg-slate-100">
        {splitLayout.panes.map((pane, index) => (
          <Fragment key={pane.id}>
            {renderPane(pane, index)}
            {index === 0 && splitLayout.panes.length > 1 ? (
              <div
                className={`flex h-full w-1 cursor-col-resize flex-col bg-slate-200 transition ${isResizing ? 'bg-sky-400' : 'hover:bg-slate-300'}`}
                onMouseDown={handleResizeStart}
              >
                <span className="sr-only">Resize panes</span>
              </div>
            ) : null}
          </Fragment>
        ))}
      </main>
      {tabContextMenu ? (
        <>
          <div className="fixed inset-0 z-40" onClick={closeTabContextMenu} />
          <div
            className="fixed z-50 w-48 rounded-md border border-slate-200 bg-white p-1 text-left shadow-lg"
            style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
              onClick={handleContextMenuSplit}
            >
              Split Right
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
              onClick={handleContextMenuClose}
            >
              Close Tab
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}

export default TabManager
