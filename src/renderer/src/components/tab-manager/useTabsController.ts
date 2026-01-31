import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  LogEditorApi,
  OpenedFile,
  SaveFileResult,
  SearchMatch,
  SearchResponsePayload,
  SearchResultItem,
  ActiveContext,
  SearchableTab,
  FileRangePayload
} from '@renderer/env'
import { buildDefaultFilename, clamp, generateTabId } from './helpers'
import { WELCOME_TAB_ID, isFileTab, isSearchTab, type FileTab, type SearchTab, type Tab, type WelcomeTab } from './tab-types'
import { buildSearchTabTitle } from './search-utils'
import { countLines, countLinesForAppend } from '@renderer/utils/text-metrics'

const api: LogEditorApi = window.api
const DEFAULT_CHUNK_SIZE = 512 * 1024
const WINDOW_OVERLAP_BYTES = 64 * 1024
const textEncoder = new TextEncoder()

const getByteLength = (value: string): number => textEncoder.encode(value).length
const LARGE_FILE_SYNC_THRESHOLD_BYTES = 8 * 1024 * 1024

const createWelcomeTab = (isActive: boolean): WelcomeTab => ({
  kind: 'welcome',
  id: WELCOME_TAB_ID,
  title: 'Welcome',
  isActive
})

type UseTabsControllerResult = {
  tabs: Tab[]
  activeTabId: string | null
  activeTab: Tab | null
  tabsRef: React.MutableRefObject<Tab[]>
  activeTabIdRef: React.MutableRefObject<string | null>
  createNewTab(): void
  openFiles(): Promise<void>
  openFilesFromPaths(filePaths: string[]): Promise<void>
  openFilesFromContent(files: OpenedFile[]): void
  switchTab(tabId: string): void
  closeTab(tabId: string): void
  updateTabContent(tabId: string, content: string): void
  handleSave(forceSaveAs: boolean): Promise<void>
  handleSearchResultSelect(result: SearchResultItem, match: SearchMatch): void
  loadMoreContent(tabId: string, direction?: 'forward' | 'backward'): Promise<void>
  jumpToFilePosition(tabId: string, ratio: number): Promise<void>
  ensureLineVisible(tabId: string, line: number): Promise<void>
}

const debugLog = (...args: unknown[]): void => {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.log('[TabManager]', ...args)
  }
}

const buildWindowedTabState = (tab: FileTab, range: FileRangePayload): FileTab => {
  const chunkLineCount = range.lineCount ?? countLines(range.content)
  const startLine = Math.max(1, range.startLine ?? tab.lineWindowStart)
  const windowEndLine = startLine + Math.max(0, chunkLineCount - 1)
  const previousTotal = tab.lineCount ?? 0
  const reachedFileEnd = !range.hasMore && range.end >= range.totalSize
  const hasAuthoritativeTotal = previousTotal > tab.loadedLineCount
  const shouldLockTotal = hasAuthoritativeTotal && !reachedFileEnd
  const nextTotalLineCount = shouldLockTotal
    ? previousTotal
    : Math.max(previousTotal, windowEndLine)
  const windowed = range.start > 0 || range.end < range.totalSize
  return {
    ...tab,
    content: range.content,
    size: range.totalSize,
    loadedRange: { start: range.start, end: range.end },
    loadedLineCount: chunkLineCount,
    lineWindowStart: startLine,
    lineCount: nextTotalLineCount,
    isTruncated: windowed || tab.isTruncated,
    isWindowed: windowed,
    isLoadingMore: false,
    hasWindowEdits: false
  }
}

export const useTabsController = (): UseTabsControllerResult => {
  const [tabs, setTabs] = useState<Tab[]>(() => [createWelcomeTab(true)])
  const [activeTabId, setActiveTabId] = useState<string | null>(WELCOME_TAB_ID)

  const tabsRef = useRef<Tab[]>([createWelcomeTab(true)])
  const activeTabIdRef = useRef<string | null>(WELCOME_TAB_ID)
  const activationStackRef = useRef<string[]>([WELCOME_TAB_ID])
  const untitledCounterRef = useRef<number>(1)
  const pendingSyncMapRef = useRef<Map<string, SearchableTab>>(new Map())

  const enqueueTabStateSync = useCallback((tab: FileTab) => {
    const shouldOmitContent = tab.isTruncated || tab.size >= LARGE_FILE_SYNC_THRESHOLD_BYTES
    pendingSyncMapRef.current.set(tab.id, {
      id: tab.id,
      title: tab.title,
      filePath: tab.filePath,
      content: shouldOmitContent ? '' : tab.content,
      size: tab.size,
      isTruncated: tab.isTruncated || shouldOmitContent,
      loadedRange: tab.loadedRange,
      lineCount: tab.lineCount,
      loadedLineCount: tab.loadedLineCount
    })
  }, [])

  useEffect(() => {
    if (!pendingSyncMapRef.current.size) {
      return
    }
    const payloads = Array.from(pendingSyncMapRef.current.values())
    pendingSyncMapRef.current.clear()
    payloads.forEach((payload) => {
      api.syncTabState(payload)
    })
  }, [tabs])

  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  useEffect(() => {
    activeTabIdRef.current = activeTabId
  }, [activeTabId])

  const updateActiveTab = useCallback((id: string | null) => {
    debugLog('updateActiveTab', id)
    setActiveTabId(id)
    activeTabIdRef.current = id
    if (id) {
      activationStackRef.current = activationStackRef.current.filter((tabId) => tabId !== id)
      activationStackRef.current.push(id)
    }
  }, [])

  useEffect(() => {
    const existingIds = new Set(tabs.map((tab) => tab.id))
    activationStackRef.current = activationStackRef.current.filter((tabId) => existingIds.has(tabId))
    if (activeTabId && existingIds.has(activeTabId)) {
      activationStackRef.current = activationStackRef.current.filter((tabId) => tabId !== activeTabId)
      activationStackRef.current.push(activeTabId)
    }
  }, [activeTabId, tabs])

  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId) ?? null, [tabs, activeTabId])

  useEffect(() => {
    let context: ActiveContext
    if (!activeTab) {
      context = { kind: 'welcome' }
    } else if (isFileTab(activeTab)) {
      context = { kind: 'file', tabId: activeTab.id }
    } else if (isSearchTab(activeTab)) {
      context = { kind: 'search', searchId: activeTab.id }
    } else {
      context = { kind: 'welcome' }
    }
    debugLog('updateActiveContext', context)
    api.updateActiveContext(context)
  }, [activeTab])

  useEffect(() => {
    return () => {
      tabsRef.current
        .filter((tab): tab is SearchTab => tab.kind === 'search')
        .forEach((searchTab) => {
          debugLog('cleanup disposing search results', searchTab.id)
          api.disposeSearchResults(searchTab.id)
        })
    }
  }, [])

  const createNewTab = useCallback(() => {
    const id = generateTabId()
    const title = `Untitled ${untitledCounterRef.current}`
    untitledCounterRef.current += 1

    debugLog('createNewTab', { id, title })
    setTabs((prev) => {
      const reset = prev.map((tab) => ({ ...tab, isActive: false }))
      const newTab: FileTab = {
        kind: 'file',
        id,
        title,
        content: '',
        size: 0,
        loadedRange: { start: 0, end: 0 },
        chunkSize: DEFAULT_CHUNK_SIZE,
        isTruncated: false,
        isReadOnly: false,
        isLoadingMore: false,
        filePath: undefined,
        isDirty: false,
        isActive: true,
        lineCount: 1,
        loadedLineCount: 1,
        lineWindowStart: 1,
        isWindowed: false,
        windowOverlap: WINDOW_OVERLAP_BYTES,
        hasWindowEdits: false
      }
      enqueueTabStateSync(newTab)
      const nextTabs = [...reset, newTab]
      debugLog('createNewTab:setTabs', {
        previousIds: prev.map((tab) => tab.id),
        nextIds: nextTabs.map((tab) => tab.id)
      })
      return nextTabs
    })
    updateActiveTab(id)
  }, [enqueueTabStateSync, updateActiveTab])

  const applyOpenedFiles = useCallback(
    (files: OpenedFile[]) => {
      if (!files.length) {
        debugLog('applyOpenedFiles received empty payload')
        return
      }

      const buildKey = (filePath: string | undefined, name: string): string => {
        if (filePath && filePath.length > 0) {
          return `path:${filePath}`
        }
        return `name:${name.trim().toLowerCase()}`
      }

      const currentTabs = tabsRef.current
      let updatedTabs = currentTabs.map((tab) => ({ ...tab, isActive: false }))
      let activeId = activeTabIdRef.current

      files.forEach((file) => {
        const filePath = file.filePath
        const fileName =
          file.name && file.name.length > 0
            ? file.name
            : filePath
              ? window.electron.path.basename(filePath)
              : 'Untitled'
        const targetKey = buildKey(filePath, fileName)

        const existingIndex = updatedTabs.findIndex(
          (tab) => isFileTab(tab) && buildKey(tab.filePath, tab.title) === targetKey
        )

        if (existingIndex >= 0) {
          const existingTab = updatedTabs[existingIndex] as FileTab
          debugLog('applyOpenedFiles refreshing existing tab', {
            key: targetKey,
            tabId: existingTab.id
          })
          const chunkSize = file.chunkSize > 0 ? file.chunkSize : existingTab.chunkSize
          const loadedBytes =
            typeof file.loadedBytes === 'number' && file.loadedBytes >= 0
              ? file.loadedBytes
              : file.content.length
          const totalLineCount = file.lineCount ?? countLines(file.content)
          const loadedLineCount = file.loadedLineCount ?? countLines(file.content)
          const incomingFilePath = file.filePath && file.filePath.length > 0 ? file.filePath : undefined
          const effectiveFilePath = incomingFilePath ?? existingTab.filePath
          const canEdit = Boolean(effectiveFilePath)
          const isWindowed = Boolean(file.isTruncated && canEdit)
          const isTruncated = Boolean(file.isTruncated)
          const refreshedTab: FileTab = {
            ...existingTab,
            content: file.content,
            title: fileName,
            filePath: effectiveFilePath,
            size: file.size ?? loadedBytes,
            loadedRange: { start: 0, end: loadedBytes },
            chunkSize,
            isTruncated,
            isReadOnly: !canEdit,
            isLoadingMore: false,
            isDirty: false,
            isActive: true,
            lineCount: totalLineCount,
            loadedLineCount,
            lineWindowStart: 1,
            isWindowed,
            windowOverlap: Math.min(WINDOW_OVERLAP_BYTES, Math.floor(chunkSize / 2)),
            hasWindowEdits: false
          }
          enqueueTabStateSync(refreshedTab)
          updatedTabs[existingIndex] = refreshedTab
          activeId = refreshedTab.id
        } else {
          const id = generateTabId()
          debugLog('applyOpenedFiles creating new tab', {
            key: targetKey,
            tabId: id,
            title: fileName
          })
          const loadedBytes =
            typeof file.loadedBytes === 'number' && file.loadedBytes >= 0
              ? file.loadedBytes
              : file.content.length
          const chunkSize = file.chunkSize > 0 ? file.chunkSize : DEFAULT_CHUNK_SIZE
          const incomingFilePath = file.filePath && file.filePath.length > 0 ? file.filePath : undefined
          const canEdit = Boolean(incomingFilePath)
          const isWindowed = Boolean(file.isTruncated && canEdit)
          const isTruncated = Boolean(file.isTruncated)
          const newTab: FileTab = {
            kind: 'file',
            id,
            title: fileName,
            filePath: incomingFilePath,
            content: file.content,
            size: file.size ?? loadedBytes,
            loadedRange: { start: 0, end: loadedBytes },
            chunkSize,
            isTruncated,
            isReadOnly: !canEdit,
            isLoadingMore: false,
            isDirty: false,
            isActive: true,
            lineCount: file.lineCount ?? countLines(file.content),
            loadedLineCount: file.loadedLineCount ?? countLines(file.content),
            lineWindowStart: 1,
            isWindowed,
            windowOverlap: Math.min(WINDOW_OVERLAP_BYTES, Math.floor(chunkSize / 2)),
            hasWindowEdits: false
          }
          enqueueTabStateSync(newTab)
          updatedTabs = [...updatedTabs, newTab]
          activeId = id
        }
      })

      const nextActiveTabId = activeId ?? updatedTabs.find((tab) => tab.isActive)?.id ?? null
      debugLog('applyOpenedFiles computed result', {
        nextActiveTabId,
        tabIds: updatedTabs.map((tab) => tab.id)
      })

      tabsRef.current = updatedTabs
      setTabs(updatedTabs)
      updateActiveTab(nextActiveTabId)
    },
    [enqueueTabStateSync, updateActiveTab]
  )

  const openFiles = useCallback(async () => {
    const files = await api.openFileDialog()
    if (!files.length) {
      debugLog('openFiles canceled or empty')
      return
    }

    debugLog(
      'openFiles received',
      files.map((file) => file.filePath ?? file.name)
    )
    applyOpenedFiles(files)
  }, [applyOpenedFiles])

  const openFilesFromPaths = useCallback(
    async (filePaths: string[]) => {
      if (!filePaths.length) {
        debugLog('openFilesFromPaths called with no paths')
        return
      }

      const files = await api.readFilesFromPaths(filePaths)
      if (!files.length) {
        debugLog('openFilesFromPaths resolved empty file list', filePaths)
        return
      }

      debugLog(
        'openFilesFromPaths received',
        files.map((file) => file.filePath ?? file.name)
      )
      applyOpenedFiles(files)
    },
    [applyOpenedFiles]
  )

  const openFilesFromContent = useCallback(
    (files: OpenedFile[]) => {
      if (!files.length) {
        debugLog('openFilesFromContent called with empty payload')
        return
      }
      debugLog('openFilesFromContent received', files.map((file) => file.name))
      applyOpenedFiles(files)
    },
    [applyOpenedFiles]
  )

  const switchTab = useCallback((tabId: string) => {
    debugLog('switchTab', tabId)
    setTabs((prev) =>
      prev.map((tab) => ({
        ...tab,
        isActive: tab.id === tabId
      }))
    )
    updateActiveTab(tabId)
  }, [updateActiveTab])

  const closeTab = useCallback((tabId: string) => {
    debugLog('closeTab', tabId)
    const currentTabs = tabsRef.current
    const target = currentTabs.find((tab) => tab.id === tabId)
    if (!target) {
      debugLog('closeTab skipped: target not found', tabId)
      return
    }

    const remaining = currentTabs.filter((tab) => tab.id !== tabId)

    activationStackRef.current = activationStackRef.current.filter((id) => id !== tabId)
    const remainingIds = new Set(remaining.map((tab) => tab.id))
    activationStackRef.current = activationStackRef.current.filter((id) => remainingIds.has(id))

    if (!remaining.length) {
      activationStackRef.current = []
      tabsRef.current = []
      setTabs([])
      updateActiveTab(null)
    } else {
      let nextActiveId =
        activationStackRef.current.length > 0
          ? activationStackRef.current[activationStackRef.current.length - 1]
          : null

      if (!nextActiveId || !remainingIds.has(nextActiveId)) {
        nextActiveId = remaining[remaining.length - 1]?.id ?? null
      }

      const nextTabs = remaining.map((tab) => ({
        ...tab,
        isActive: tab.id === nextActiveId
      }))

      tabsRef.current = nextTabs
      setTabs(nextTabs)
      updateActiveTab(nextActiveId)
    }

    if (isFileTab(target)) {
      debugLog('closeTab removing tab state', target.id)
      api.removeTabState(tabId)
    } else if (isSearchTab(target)) {
      debugLog('closeTab disposing search results', target.id)
      api.disposeSearchResults(target.id)
    }
  }, [updateActiveTab])

  const updateTabContent = useCallback((tabId: string, content: string) => {
    debugLog('updateTabContent', { tabId, length: content.length })
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== tabId || !isFileTab(tab)) {
          return tab
        }
        if (tab.isReadOnly) {
          debugLog('updateTabContent skipped (read-only tab)', tabId)
          return tab
        }
        const totalLineCount = countLines(content)
        if (tab.isWindowed) {
          const lineDelta = totalLineCount - tab.loadedLineCount
          const updatedTab: FileTab = {
            ...tab,
            content,
            isDirty: true,
            loadedLineCount: totalLineCount,
            lineCount: Math.max(1, tab.lineCount + lineDelta),
            hasWindowEdits: true
          }
          enqueueTabStateSync(updatedTab)
          return updatedTab
        }
        const updatedTab: FileTab = {
          ...tab,
          content,
          size: content.length,
          loadedRange: { start: 0, end: content.length },
          isTruncated: false,
          isDirty: true,
          lineCount: totalLineCount,
          loadedLineCount: totalLineCount,
          hasWindowEdits: false
        }
        enqueueTabStateSync(updatedTab)
        return updatedTab
      })
    )
  }, [enqueueTabStateSync])

  const handleSave = useCallback(
    async (forceSaveAs: boolean) => {
      const currentTab = tabsRef.current.find(
        (tab): tab is FileTab => tab.id === activeTabIdRef.current && isFileTab(tab)
      )
      if (!currentTab) {
        debugLog('handleSave skipped: no current file tab')
        return
      }

      if (currentTab.isWindowed && currentTab.filePath) {
        const applyWindowChanges = async (targetPath: string, updateTitle: boolean) => {
          const replacementLength = getByteLength(currentTab.content)
          const result = await api.applyWindowEdit({
            filePath: targetPath,
            rangeStart: currentTab.loadedRange.start,
            rangeEnd: currentTab.loadedRange.end,
            replacement: currentTab.content
          })
          const nextTitle = updateTitle ? window.electron.path.basename(targetPath) : currentTab.title
          debugLog('handleSave window patch applied', {
            tabId: currentTab.id,
            targetPath,
            replacementLength
          })
          setTabs((prev) =>
            prev.map((tab) => {
              if (tab.id !== currentTab.id || !isFileTab(tab)) {
                return tab
              }
              const updatedTab: FileTab = {
                ...tab,
                filePath: targetPath,
                title: nextTitle,
                size: result.size,
                loadedRange: {
                  start: tab.loadedRange.start,
                  end: tab.loadedRange.start + replacementLength
                },
                isDirty: false,
                hasWindowEdits: false
              }
              enqueueTabStateSync(updatedTab)
              return updatedTab
            })
          )
        }

        if (forceSaveAs) {
          const result: SaveFileResult = await api.saveFileDialog({
            filePath: undefined,
            defaultPath: currentTab.filePath ?? buildDefaultFilename(currentTab.title),
            sourcePath: currentTab.filePath
          })
          if (result.canceled || !result.filePath) {
            debugLog('handleSave Save As canceled', result)
            return
          }
          if (currentTab.isDirty) {
            await applyWindowChanges(result.filePath, true)
          } else {
            const newTitle = window.electron.path.basename(result.filePath)
            setTabs((prev) =>
              prev.map((tab) => {
                if (tab.id !== currentTab.id || !isFileTab(tab)) {
                  return tab
                }
                const updatedTab: FileTab = {
                  ...tab,
                  filePath: result.filePath,
                  title: newTitle
                }
                enqueueTabStateSync(updatedTab)
                return updatedTab
              })
            )
          }
          return
        }

        if (!currentTab.isDirty) {
          debugLog('handleSave skipped: window has no changes', currentTab.id)
          return
        }

        await applyWindowChanges(currentTab.filePath, false)
        return
      }

      const payload = {
        filePath: forceSaveAs ? undefined : currentTab.filePath,
        defaultPath: currentTab.filePath ?? buildDefaultFilename(currentTab.title),
        content: currentTab.content
      }

      const result: SaveFileResult = await api.saveFileDialog(payload)
      if (result.canceled || !result.filePath) {
        debugLog('handleSave canceled or no file path', result)
        return
      }

      const newTitle = window.electron.path.basename(result.filePath)
      debugLog('handleSave success', {
        tabId: currentTab.id,
        newFilePath: result.filePath,
        newTitle
      })
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === currentTab.id && isFileTab(tab)
            ? (() => {
                const updatedTab: FileTab = {
                  ...tab,
                  filePath: result.filePath,
                  title: newTitle,
                  size: tab.content.length,
                  loadedRange: { start: 0, end: tab.content.length },
                  isTruncated: false,
                  isReadOnly: false,
                  isDirty: false
                }
                enqueueTabStateSync(updatedTab)
                return updatedTab
              })()
            : tab
        )
      )
    },
    [enqueueTabStateSync]
  )

  const handleSearchResults = useCallback((payload: SearchResponsePayload) => {
    debugLog('onSearchResults received', payload)
    const totalMatches = payload.results.reduce((acc, item) => acc + item.matches.length, 0)
    const searchTab: SearchTab = {
      kind: 'search',
      id: payload.searchId,
      title: buildSearchTabTitle(payload.request, totalMatches),
      request: payload.request,
      parentSearchId: payload.parentSearchId,
      results: payload.results,
      totalMatches,
      isActive: true
    }

    setTabs((prev) => {
      const withoutCurrent = prev.filter((tab) => tab.id !== payload.searchId)
      const reset = withoutCurrent.map((tab) => ({ ...tab, isActive: false }))

      const parentIndex = searchTab.parentSearchId
        ? reset.findIndex((tab) => tab.id === searchTab.parentSearchId)
        : -1

      if (parentIndex >= 0) {
        const before = reset.slice(0, parentIndex + 1)
        const after = reset.slice(parentIndex + 1)
        return [...before, searchTab, ...after]
      }

      return [...reset, searchTab]
    })

    updateActiveTab(payload.searchId)
  }, [updateActiveTab])

  const handleSearchResultSelect = useCallback((result: SearchResultItem, match: SearchMatch) => {
    debugLog('handleSearchResultSelect', {
      tabId: result.tabId,
      line: match.line,
      column: match.column
    })
    setTabs((prev) =>
      prev.map((tab) => ({
        ...tab,
        isActive: tab.id === result.tabId
      }))
    )
    updateActiveTab(result.tabId)
  }, [updateActiveTab])

  const loadMoreContent = useCallback(
    async (tabId: string, direction: 'forward' | 'backward' = 'forward') => {
      const target = tabsRef.current.find(
        (tab): tab is FileTab => tab.id === tabId && isFileTab(tab)
      )
      if (!target) {
        debugLog('loadMoreContent skipped: missing tab', tabId)
        return
      }
      if (!target.filePath) {
        debugLog('loadMoreContent skipped: tab has no file path', tabId)
        return
      }
      if (target.isWindowed) {
        if (target.isDirty) {
          debugLog('loadMoreContent blocked: unsaved edits in window', tabId)
          throw new Error('Save or discard current edits before moving to another section.')
        }

        if (direction === 'forward' && target.loadedRange.end >= target.size) {
          debugLog('loadMoreContent skipped: reached end of file', tabId)
          return
        }
        if (direction === 'backward' && target.loadedRange.start === 0) {
          debugLog('loadMoreContent skipped: already at start', tabId)
          return
        }

        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === tabId && isFileTab(tab)
              ? {
                  ...tab,
                  isLoadingMore: true
                }
              : tab
          )
        )

        try {
          const chunkSize = target.chunkSize > 0 ? target.chunkSize : DEFAULT_CHUNK_SIZE
          const overlap = Math.min(target.windowOverlap, Math.floor(chunkSize / 4))
          const forwardStart = Math.min(
            target.size - chunkSize,
            Math.max(target.loadedRange.end - overlap, target.loadedRange.start)
          )
          const backwardStart = Math.max(0, target.loadedRange.start - (chunkSize - overlap))
          const nextStart = direction === 'forward' ? Math.max(0, forwardStart) : backwardStart
          const range = await api.readFileRange({
            filePath: target.filePath,
            start: nextStart,
            length: chunkSize
          })
          debugLog('loadMoreContent window shift', {
            tabId,
            direction,
            start: range.start,
            end: range.end,
            startLine: range.startLine,
            lineCount: range.lineCount
          })
          const updatedTab = buildWindowedTabState(target, range)
          enqueueTabStateSync(updatedTab)
          setTabs((prev) =>
            prev.map((tab) => (tab.id === tabId && isFileTab(tab) ? updatedTab : tab))
          )
        } catch (error) {
          setTabs((prev) =>
            prev.map((tab) =>
              tab.id === tabId && isFileTab(tab)
                ? {
                    ...tab,
                    isLoadingMore: false
                  }
                : tab
            )
          )
          throw error
        }
        return
      }

      if (!target.isTruncated) {
        debugLog('loadMoreContent skipped: tab fully loaded', tabId)
        return
      }
      if (target.isLoadingMore) {
        debugLog('loadMoreContent skipped: already loading', tabId)
        return
      }

      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId && isFileTab(tab)
            ? {
                ...tab,
                isLoadingMore: true
              }
            : tab
        )
      )

      try {
        const range = await api.readFileRange({
          filePath: target.filePath,
          start: target.loadedRange.end,
          length: target.chunkSize > 0 ? target.chunkSize : DEFAULT_CHUNK_SIZE
        })
        debugLog('loadMoreContent resolved', {
          tabId,
          start: range.start,
          end: range.end,
          hasMore: range.hasMore
        })
        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.id !== tabId || !isFileTab(tab)) {
              return tab
            }
            const appendedContent = tab.content + range.content
            const appendedLines = countLinesForAppend(range.content, tab.content.endsWith('\n'))
            const nextLoadedLines = tab.loadedLineCount + appendedLines
            const updatedTab: FileTab = {
              ...tab,
              content: appendedContent,
              size: range.totalSize,
              loadedRange: { start: 0, end: range.end },
              isTruncated: range.hasMore,
              isReadOnly: range.hasMore ? tab.isReadOnly : false,
              isLoadingMore: false,
              loadedLineCount: nextLoadedLines,
              lineCount: tab.lineCount ?? nextLoadedLines
            }
            enqueueTabStateSync(updatedTab)
            return updatedTab
          })
        )
      } catch (error) {
        debugLog('loadMoreContent failed', { tabId, error })
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === tabId && isFileTab(tab)
              ? {
                  ...tab,
                  isLoadingMore: false
                }
              : tab
          )
        )
        throw error
      }
    },
    [api, enqueueTabStateSync]
  )

  const jumpToFilePosition = useCallback(
    async (tabId: string, ratio: number) => {
      const target = tabsRef.current.find(
        (tab): tab is FileTab => tab.id === tabId && isFileTab(tab)
      )
      if (!target || !target.isWindowed) {
        debugLog('jumpToFilePosition skipped: tab not windowed', tabId)
        return
      }
      if (!target.filePath) {
        debugLog('jumpToFilePosition skipped: missing file path', tabId)
        return
      }
      if (target.isDirty || target.isLoadingMore) {
        debugLog('jumpToFilePosition blocked: dirty or loading', tabId)
        return
      }

      const safeRatio = clamp(Number.isFinite(ratio) ? ratio : 0, 0, 1)
      const chunkSize = target.chunkSize > 0 ? target.chunkSize : DEFAULT_CHUNK_SIZE
      const anchor = Math.round(target.size * safeRatio)
      const start = clamp(Math.round(anchor - chunkSize / 2), 0, Math.max(0, target.size - chunkSize))

      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId && isFileTab(tab)
            ? {
                ...tab,
                isLoadingMore: true
              }
            : tab
        )
      )

      try {
        const range = await api.readFileRange({
          filePath: target.filePath,
          start,
          length: chunkSize
        })
        debugLog('jumpToFilePosition resolved', {
          tabId,
          ratio: safeRatio,
          start: range.start,
          end: range.end
        })
        const updatedTab = buildWindowedTabState(target, range)
        enqueueTabStateSync(updatedTab)
        setTabs((prev) =>
          prev.map((tab) => (tab.id === tabId && isFileTab(tab) ? updatedTab : tab))
        )
      } catch (error) {
        debugLog('jumpToFilePosition failed', { tabId, error })
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === tabId && isFileTab(tab)
              ? {
                  ...tab,
                  isLoadingMore: false
                }
              : tab
          )
        )
        throw error
      }
    },
    [api, enqueueTabStateSync]
  )

  const ensureLineVisible = useCallback(
    async (tabId: string, line: number) => {
      const MAX_ITERATIONS = 200
      let iterations = 0
      while (iterations < MAX_ITERATIONS) {
        iterations += 1
        const target = tabsRef.current.find(
          (tab): tab is FileTab => tab.id === tabId && isFileTab(tab)
        )
        if (!target || !target.isWindowed) {
          break
        }
        const windowStart = target.lineWindowStart
        const windowEnd = target.lineWindowStart + Math.max(0, target.loadedLineCount - 1)
        if (line >= windowStart && line <= windowEnd) {
          break
        }
        if (line < windowStart) {
          await loadMoreContent(tabId, 'backward')
        } else {
          await loadMoreContent(tabId, 'forward')
        }
      }
    },
    [loadMoreContent]
  )

  useEffect(() => {
    const disposers = [
      api.onMenuNewFile(() => createNewTab()),
      api.onMenuOpenFile(() => openFiles()),
      api.onMenuSaveFile(() => void handleSave(false)),
      api.onMenuSaveFileAs(() => void handleSave(true)),
      api.onSearchResults((payload: SearchResponsePayload) => handleSearchResults(payload))
    ]

    return () => {
      disposers.forEach((dispose) => dispose())
    }
  }, [createNewTab, handleSave, handleSearchResults, openFiles, updateActiveTab])

  return {
    tabs,
    activeTabId,
    activeTab,
    tabsRef,
    activeTabIdRef,
    createNewTab,
    openFiles,
    openFilesFromPaths,
    openFilesFromContent,
    switchTab,
    closeTab,
    updateTabContent,
    handleSave,
    handleSearchResultSelect,
    loadMoreContent,
    jumpToFilePosition,
    ensureLineVisible
  }
}
