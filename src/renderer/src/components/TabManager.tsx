import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import type { LogEditorApi, OpenedFile, SearchMatch, SearchResultItem } from '@renderer/env'
import { SearchResultsPanel } from './tab-manager/SearchResultsPanel'
import { LINE_NUMBER_GUTTER_WIDTH } from './tab-manager/constants'
import { clamp } from './tab-manager/helpers'
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

type ExtractedTransferPayload = {
  filePaths: string[]
  blobFiles: File[]
}

const extractTransferPayload = (transfer: DataTransfer | null): ExtractedTransferPayload => {
  if (!transfer) {
    return { filePaths: [], blobFiles: [] }
  }

  const filePaths = new Set<string>(collectDroppedFilePaths(transfer))
  const blobFiles: File[] = []

  Array.from(transfer.files ?? []).forEach((file) => {
    const fileWithPath = file as File & { path?: string }
    if (fileWithPath.path && fileWithPath.path.length > 0) {
      filePaths.add(fileWithPath.path)
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

  const editorRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})
  const highlightRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const lineViewportRef = useRef<Record<string, LineViewportState>>({})
  const lineViewportAnimationRef = useRef<number | null>(null)
  const [, forceLineViewportRender] = useState(0)
  const autoScrollIntentRef = useRef<Record<string, boolean>>({})
  const defaultLineViewport: LineViewportState = {
    firstLine: 1,
    offset: 0,
    visibleLines: MAX_RENDERED_LINE_NUMBERS,
    lineHeight: 24,
    paddingTop: 0
  }
  const highlightInfoRef = useRef<{ tabId: string; line: number } | null>(null)
  const highlightTimeoutRef = useRef<number | null>(null)
  const searchContainerRef = useRef<HTMLDivElement | null>(null)
  const searchObserverRef = useRef<MutationObserver | null>(null)
  const scheduleLineViewportUpdate = useCallback(
    (tabId: string, textarea: HTMLTextAreaElement | null) => {
      if (!textarea) {
        return
      }
      if (lineViewportAnimationRef.current) {
        cancelAnimationFrame(lineViewportAnimationRef.current)
      }
      lineViewportAnimationRef.current = window.requestAnimationFrame(() => {
        const styles = getComputedStyle(textarea)
        const lineHeight = parseFloat(styles.lineHeight || '20') || 20
        const paddingTop = parseFloat(styles.paddingTop || '0') || 0
        const scrollTop = textarea.scrollTop
        const firstLine = Math.max(1, Math.floor(scrollTop / lineHeight) + 1)
        const offset = scrollTop - (firstLine - 1) * lineHeight
        const visibleLines = Math.max(
          1,
          Math.ceil(textarea.clientHeight / lineHeight) + 4
        )
        lineViewportRef.current[tabId] = {
          firstLine,
          offset,
          visibleLines,
          lineHeight,
          paddingTop
        }
        forceLineViewportRender((value) => value + 1)
        lineViewportAnimationRef.current = null
      })
    },
    []
  )

  const {
    tabs,
    activeTabId,
    activeTab,
    tabsRef,
    activeTabIdRef,
    createNewTab,
    openFilesFromPaths,
    openFilesFromContent,
    switchTab,
    closeTab,
    updateTabContent,
    handleSearchResultSelect,
    loadMoreContent
  } = useTabsController()

  const focusLine = useCallback(
    (tabId: string, line: number, column = 1) => {
      const textarea = editorRefs.current[tabId]
      const overlay = highlightRefs.current[tabId]
      if (!textarea || !overlay) {
        return
      }

      const styles = getComputedStyle(textarea)
      const lineHeight = parseFloat(styles.lineHeight || '20')
      const paddingTop = parseFloat(styles.paddingTop || '0')
      const lines = textarea.value.split(/\r?\n/)
      const targetLine = clamp(line, 1, Math.max(1, lines.length))
      const safeColumn = clamp(column, 1, (lines[targetLine - 1]?.length ?? 0) + 1)

      let charIndex = 0
      for (let i = 0; i < targetLine - 1; i += 1) {
        charIndex += (lines[i]?.length ?? 0) + 1
      }

      const selectionStart = charIndex + safeColumn - 1
      textarea.focus()
      textarea.setSelectionRange(selectionStart, selectionStart)

      const visibleArea = textarea.clientHeight
      const desiredScrollTop = Math.max(0, paddingTop + (targetLine - 1) * lineHeight - visibleArea / 2)

      textarea.scrollTop = desiredScrollTop
      scheduleLineViewportUpdate(tabId, textarea)

      const paintHighlight = (): void => {
        const top = paddingTop + (targetLine - 1) * lineHeight - textarea.scrollTop
        overlay.style.top = `${Math.max(top, 0)}px`
        overlay.style.height = `${lineHeight}px`
        overlay.style.opacity = '1'
        overlay.style.transition = 'opacity 0.3s ease'
      }

      paintHighlight()
      requestAnimationFrame(paintHighlight)

      highlightInfoRef.current = { tabId, line: targetLine }
      if (highlightTimeoutRef.current) {
        window.clearTimeout(highlightTimeoutRef.current)
      }
      highlightTimeoutRef.current = window.setTimeout(() => {
        overlay.style.opacity = '0'
        highlightInfoRef.current = null
      }, 2000)
    },
    [scheduleLineViewportUpdate]
  )

  useEffect(() => {
    if (!activeTabId) {
      return
    }
    const activeTabRecord = tabsRef.current.find((tab) => tab.id === activeTabId)
    if (!activeTabRecord || !isFileTab(activeTabRecord)) {
      return
    }
    const textarea = editorRefs.current[activeTabRecord.id]
    const overlay = highlightRefs.current[activeTabRecord.id]
    if (!textarea || !overlay) {
      return
    }
    overlay.style.left = `${LINE_NUMBER_GUTTER_WIDTH}px`
    overlay.style.right = '0px'

    const updateOverlayPosition = (): void => {
      scheduleLineViewportUpdate(activeTabRecord.id, textarea)
      const highlight = highlightInfoRef.current
      if (!highlight || highlight.tabId !== activeTabIdRef.current) {
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
  }, [activeTabId, activeTabIdRef, tabsRef, scheduleLineViewportUpdate])

  useEffect(() => {
    if (!activeTab || !isFileTab(activeTab)) {
      return
    }
    const textarea = editorRefs.current[activeTab.id]
    if (textarea) {
      scheduleLineViewportUpdate(activeTab.id, textarea)
    }
  }, [activeTab, scheduleLineViewportUpdate])

  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) {
        window.clearTimeout(highlightTimeoutRef.current)
      }
      searchObserverRef.current?.disconnect()
      if (lineViewportAnimationRef.current) {
        cancelAnimationFrame(lineViewportAnimationRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const disposer = api.onSearchNavigate((payload) => {
      const exists = tabsRef.current.some((tab) => tab.id === payload.tabId)
      if (!exists) {
        return
      }
      switchTab(payload.tabId)
      requestAnimationFrame(() => focusLine(payload.tabId, payload.line, payload.column))
    })

    return () => {
      disposer()
    }
  }, [focusLine, switchTab, tabsRef])

  useEffect(() => {
    tabs.forEach((tab) => {
      if (!isFileTab(tab)) {
        return
      }
      if (!autoScrollIntentRef.current[tab.id]) {
        return
      }
      if (tab.isLoadingMore) {
        return
      }
      const textarea = editorRefs.current[tab.id]
      if (textarea) {
        textarea.scrollTop = textarea.scrollHeight - textarea.clientHeight
        scheduleLineViewportUpdate(tab.id, textarea)
      }
      autoScrollIntentRef.current[tab.id] = false
    })
  }, [scheduleLineViewportUpdate, tabs])

  const handleDragOver = useCallback((event: ReactDragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleDrop = useCallback(
    (event: ReactDragEvent) => {
      event.preventDefault()
      event.stopPropagation()
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
    [openFilesFromContent, openFilesFromPaths]
  )

  const handleFileScroll = useCallback(
    (tab: FileTab, textarea: HTMLTextAreaElement) => {
      scheduleLineViewportUpdate(tab.id, textarea)
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
        autoScrollIntentRef.current[tab.id] = scrollRatio > 0.9
        void loadMoreContent(tab.id).catch((error) => {
          if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.error('[TabManager] auto load failed', error)
          }
        })
      }
    },
    [loadMoreContent, scheduleLineViewportUpdate]
  )

  useEffect(() => {
    if (activeTab && isSearchTab(activeTab)) {
      if (searchContainerRef.current) {
        searchContainerRef.current.style.opacity = '1'
      }
    }
  }, [activeTab])

  useEffect(() => {
    const container = searchContainerRef.current
    if (!container || !activeTab || !isSearchTab(activeTab)) {
      searchObserverRef.current?.disconnect()
      searchObserverRef.current = null
      return
    }

    const enforceOpacity = () => {
      const currentOpacity = container.style.opacity
      if (currentOpacity !== '' && currentOpacity !== '1') {
        container.style.opacity = '1'
      }
    }

    enforceOpacity()
    container.style.transition = 'none'

    const observer = new MutationObserver(enforceOpacity)
    observer.observe(container, { attributes: true, attributeFilter: ['style'] })
    searchObserverRef.current = observer

    const handleScrollOrPointer = () => {
      enforceOpacity()
    }

    container.addEventListener('scroll', handleScrollOrPointer)
    container.addEventListener('mouseenter', handleScrollOrPointer)
    container.addEventListener('mouseleave', handleScrollOrPointer)

    return () => {
      observer.disconnect()
      if (searchObserverRef.current === observer) {
        searchObserverRef.current = null
      }
      container.removeEventListener('scroll', handleScrollOrPointer)
      container.removeEventListener('mouseenter', handleScrollOrPointer)
      container.removeEventListener('mouseleave', handleScrollOrPointer)
    }
  }, [activeTab])

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

  const handleSelectSearchMatch = useCallback(
    (result: SearchResultItem, match: SearchMatch) => {
      handleSearchResultSelect(result, match)
      const ensureLoaded = async () => {
        const MAX_ITERATIONS = 400
        let attempts = 0
        while (attempts < MAX_ITERATIONS) {
          attempts += 1
          const targetTab = tabsRef.current.find((tab) => tab.id === result.tabId)
          if (!targetTab || !isFileTab(targetTab) || !targetTab.isTruncated) {
            break
          }
          if (match.line <= targetTab.loadedLineCount) {
            break
          }
          try {
            await loadMoreContent(targetTab.id)
            await new Promise((resolve) => {
              window.requestAnimationFrame(() => resolve(undefined))
            })
          } catch (error) {
            if (import.meta.env.DEV) {
              // eslint-disable-next-line no-console
              console.error('[TabManager] failed to auto-load chunk', error)
            }
            break
          }
        }
        requestAnimationFrame(() => focusLine(result.tabId, match.line, match.column))
      }
      void ensureLoaded()
    },
    [focusLine, handleSearchResultSelect, loadMoreContent, tabsRef]
  )

  const renderSearchContent = useCallback(
    (tab: SearchTab) => (
      <SearchResultsPanel ref={searchContainerRef} tab={tab} onSelectMatch={handleSelectSearchMatch} />
    ),
    [handleSelectSearchMatch]
  )

  const renderActiveContent = (tab: Tab | null): React.ReactNode => {
    if (!tab) {
      return renderWelcomeContent()
    }
    if (isFileTab(tab)) {
      const loadedBytes = Math.max(0, tab.loadedRange.end - tab.loadedRange.start)
      const totalBytes = tab.size > 0 ? tab.size : loadedBytes
      const viewport = lineViewportRef.current[tab.id] ?? defaultLineViewport
      const totalLines = Math.max(tab.loadedLineCount, 1)
      const safeFirstLine = Math.min(viewport.firstLine, totalLines)
      const remaining = Math.max(1, totalLines - safeFirstLine + 1)
      const lineRenderCount = Math.max(
        1,
        Math.min(viewport.visibleLines, remaining, MAX_RENDERED_LINE_NUMBERS)
      )
      const lineNumbers = Array.from({ length: lineRenderCount }, (_, index) => safeFirstLine + index)
      return (
        <div className="relative flex h-full flex-col">
          {tab.isReadOnly ? (
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
          <div className="flex h-full">
            <div className="relative h-full shrink-0 overflow-hidden border-r border-slate-200 bg-slate-100/80">
              <div
                className="w-14 px-3 py-0 text-right font-mono text-xs text-slate-400 will-change-transform"
                style={{
                  transform: `translateY(-${viewport.offset}px)`,
                  paddingTop: `${viewport.paddingTop}px`
                }}
              >
                {lineNumbers.map((lineNumber) => (
                  <span
                    key={`${tab.id}-line-${lineNumber}`}
                    className="block"
                    style={{
                      height: `${viewport.lineHeight}px`,
                      lineHeight: `${viewport.lineHeight}px`
                    }}
                  >
                    {lineNumber}
                  </span>
                ))}
              </div>
            </div>
            <textarea
              ref={(el) => {
                editorRefs.current[tab.id] = el
                scheduleLineViewportUpdate(tab.id, el)
              }}
              value={tab.content}
              onChange={(event) => updateTabContent(tab.id, event.target.value)}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onScroll={(event) => handleFileScroll(tab, event.currentTarget)}
              readOnly={tab.isReadOnly}
              className={`editor-scrollbar h-full w-full resize-none p-0 font-mono text-sm leading-6 outline-none ${
                tab.isReadOnly ? 'bg-slate-50 text-slate-700' : 'bg-transparent text-slate-900'
              }`}
              spellCheck={false}
            />
          </div>
          <div
            ref={(el) => {
              highlightRefs.current[tab.id] = el
            }}
            className="pointer-events-none absolute right-0 bg-amber-200/60 opacity-0 transition-opacity"
            style={{ left: `${LINE_NUMBER_GUTTER_WIDTH}px` }}
          />
        </div>
      )
    }
    if (isWelcomeTab(tab)) {
      return renderWelcomeContent()
    }
    if (isSearchTab(tab)) {
      return renderSearchContent(tab)
    }
    return null
  }

  return (
    <div
      className="relative flex h-full flex-col bg-slate-50 text-slate-900"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <nav
        className="flex min-h-[44px] items-center gap-1 overflow-x-auto border-b border-slate-200 bg-slate-200"
        onDoubleClick={(event) => {
          const target = event.target as HTMLElement
          if (!target.closest('button')) {
            createNewTab()
          }
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => switchTab(tab.id)}
            className={`group flex h-11 items-center gap-2 border px-4 text-sm font-medium transition ${
              tab.isActive
                ? 'border-sky-500 bg-white text-sky-700'
                : 'border-transparent bg-slate-100 text-slate-500 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700'
            }`}
          >
            <span className="max-w-[200px] truncate">{tab.title}</span>
            {isFileTab(tab) && tab.isDirty ? <span className="size-2 rounded-full bg-rose-500" /> : null}
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              className="ml-1 text-xs text-slate-400 transition hover:text-sky-900"
              onClick={(event) => {
                event.stopPropagation()
                closeTab(tab.id)
              }}
            >
              ×
            </button>
          </button>
        ))}
      </nav>

      <main className="flex-1 overflow-hidden bg-slate-100">
        <div className="h-full overflow-hidden border border-slate-200 bg-white shadow-sm">
          {renderActiveContent(activeTab)}
        </div>
      </main>
    </div>
  )
}

export default TabManager
