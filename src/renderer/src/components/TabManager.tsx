import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  LogEditorApi,
  RemoveListener,
  SaveFileResult,
  SearchResultItem,
  SearchMatch
} from '../env'

type FileTab = {
  kind: 'file'
  id: string
  title: string
  filePath?: string
  content: string
  isDirty: boolean
  isActive: boolean
}

type SearchTab = {
  kind: 'search'
  id: string
  title: string
  results: SearchResultItem[]
  totalMatches: number
  isActive: boolean
}

type Tab = FileTab | SearchTab

const isFileTab = (tab: Tab): tab is FileTab => tab.kind === 'file'

const buildDefaultFilename = (title: string): string => {
  const sanitized = title.replace(/\s+/g, '_').toLowerCase()
  return sanitized.endsWith('.log') || sanitized.endsWith('.txt')
    ? sanitized
    : `${sanitized || 'untitled'}.log`
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

const MAX_SNIPPET_LENGTH = 160

const computeSnippet = (
  match: SearchMatch
): { before: string; highlight: string; after: string } => {
  const columnIndex = Math.max(0, match.column - 1)
  let before = match.preview.slice(0, columnIndex)
  const highlight = match.match
  let after = match.preview.slice(columnIndex + highlight.length)

  if (before.length > MAX_SNIPPET_LENGTH / 2) {
    before = `…${before.slice(-MAX_SNIPPET_LENGTH / 2)}`
  }

  if (after.length > MAX_SNIPPET_LENGTH / 2) {
    after = `${after.slice(0, MAX_SNIPPET_LENGTH / 2)}…`
  }

  return { before, highlight, after }
}

const api: LogEditorApi = window.api
const SEARCH_TAB_ID = 'search-results-tab'

function TabManager(): React.JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const tabsRef = useRef<Tab[]>([])
  const activeTabIdRef = useRef<string | null>(null)
  const untitledCounterRef = useRef<number>(1)
  const editorRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})
  const highlightRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const highlightInfoRef = useRef<{ tabId: string; line: number } | null>(null)
  const highlightTimeoutRef = useRef<number | null>(null)
  const statusTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  useEffect(() => {
    activeTabIdRef.current = activeTabId
  }, [activeTabId])

  useEffect(() => {
    tabs.filter(isFileTab).forEach((tab) => {
      api.syncTabState({
        id: tab.id,
        title: tab.title,
        filePath: tab.filePath,
        content: tab.content
      })
    })
  }, [tabs])

  useEffect(() => {
    if (!activeTabId) {
      return
    }
    const activeTab = tabsRef.current.find((tab) => tab.id === activeTabId)
    if (!activeTab || !isFileTab(activeTab)) {
      return
    }
    const textarea = editorRefs.current[activeTab.id]
    const overlay = highlightRefs.current[activeTab.id]
    if (!textarea || !overlay) {
      return
    }

    const updateOverlayPosition = (): void => {
      const highlight = highlightInfoRef.current
      if (!highlight || highlight.tabId !== activeTabId) {
        overlay.style.opacity = '0'
        return
      }
      const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight || '20')
      const top = (highlight.line - 1) * lineHeight - textarea.scrollTop
      overlay.style.top = `${Math.max(top, 0)}px`
      overlay.style.height = `${lineHeight}px`
    }

    updateOverlayPosition()
    textarea.addEventListener('scroll', updateOverlayPosition)

    return () => {
      textarea.removeEventListener('scroll', updateOverlayPosition)
    }
  }, [activeTabId])

  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) {
        window.clearTimeout(highlightTimeoutRef.current)
      }
      if (statusTimeoutRef.current) {
        window.clearTimeout(statusTimeoutRef.current)
      }
    }
  }, [])

  const showStatus = useCallback((message: string) => {
    if (statusTimeoutRef.current) {
      window.clearTimeout(statusTimeoutRef.current)
    }
    setStatusMessage(message)
    statusTimeoutRef.current = window.setTimeout(() => {
      setStatusMessage(null)
      statusTimeoutRef.current = null
    }, 3000)
  }, [])

  const focusLine = useCallback((tabId: string, line: number, column = 1) => {
    const textarea = editorRefs.current[tabId]
    const overlay = highlightRefs.current[tabId]
    if (!textarea || !overlay) {
      return
    }

    const textAreaEl = textarea
    const overlayEl = overlay

    const lines = textAreaEl.value.split(/\r?\n/)
    const targetLine = clamp(line, 1, Math.max(1, lines.length))
    const safeColumn = clamp(column, 1, (lines[targetLine - 1]?.length ?? 0) + 1)

    let charIndex = 0
    for (let i = 0; i < targetLine - 1; i += 1) {
      charIndex += (lines[i]?.length ?? 0) + 1
    }

    const selectionStart = charIndex + safeColumn - 1
    textAreaEl.focus()
    textAreaEl.setSelectionRange(selectionStart, selectionStart)

    const lineHeight = parseFloat(getComputedStyle(textAreaEl).lineHeight || '20')
    const visibleArea = textAreaEl.clientHeight
    const desiredScrollTop = Math.max(0, (targetLine - 1) * lineHeight - visibleArea / 2)

    textAreaEl.scrollTop = desiredScrollTop

    const paintHighlight = (): void => {
      const top = (targetLine - 1) * lineHeight - textAreaEl.scrollTop
      overlayEl.style.top = `${Math.max(top, 0)}px`
      overlayEl.style.height = `${lineHeight}px`
      overlayEl.style.opacity = '1'
      overlayEl.style.transition = 'opacity 0.3s ease'
    }

    paintHighlight()
    requestAnimationFrame(paintHighlight)

    highlightInfoRef.current = { tabId, line: targetLine }
    if (highlightTimeoutRef.current) {
      window.clearTimeout(highlightTimeoutRef.current)
    }
    highlightTimeoutRef.current = window.setTimeout(() => {
      overlayEl.style.opacity = '0'
      highlightInfoRef.current = null
    }, 2000)
  }, [])

  const createNewTab = useCallback(() => {
    const id = crypto.randomUUID()
    const title = `Untitled ${untitledCounterRef.current}`
    untitledCounterRef.current += 1

    setTabs((prev) => {
      const reset = prev.map((tab) => ({ ...tab, isActive: false }))
      const newTab: FileTab = {
        kind: 'file',
        id,
        title,
        content: '',
        filePath: undefined,
        isDirty: false,
        isActive: true
      }
      return [...reset, newTab]
    })
    setActiveTabId(id)
    showStatus(`Created ${title}`)
  }, [showStatus])

  const openFiles = useCallback(async () => {
    const files = await api.openFileDialog()
    if (!files.length) {
      return
    }

    let nextActiveTabId: string | null = activeTabIdRef.current
    setTabs((prev) => {
      let updatedTabs = prev.map((tab) => ({ ...tab, isActive: false }))
      let activeId = activeTabIdRef.current

      files.forEach((file) => {
        const existingIndex = updatedTabs.findIndex(
          (tab) => isFileTab(tab) && tab.filePath === file.filePath
        )
        if (existingIndex >= 0) {
          const existingTab = updatedTabs[existingIndex] as FileTab
          const refreshedTab: FileTab = {
            ...existingTab,
            content: file.content,
            isDirty: false,
            isActive: true
          }
          updatedTabs[existingIndex] = refreshedTab
          activeId = refreshedTab.id
        } else {
          const id = crypto.randomUUID()
          const title = window.electron.path.basename(file.filePath)
          const newTab: FileTab = {
            kind: 'file',
            id,
            title,
            filePath: file.filePath,
            content: file.content,
            isDirty: false,
            isActive: true
          }
          updatedTabs = updatedTabs.map((tab) => ({ ...tab, isActive: false }))
          updatedTabs = [...updatedTabs, newTab]
          activeId = id
        }
      })

      nextActiveTabId = activeId ?? null
      return updatedTabs
    })
    setActiveTabId(nextActiveTabId)

    const status =
      files.length === 1 ? `Opened ${files[0].filePath}` : `Opened ${files.length} files`
    showStatus(status)
  }, [showStatus])

  const switchTab = useCallback((tabId: string) => {
    setTabs((prev) =>
      prev.map((tab) => ({
        ...tab,
        isActive: tab.id === tabId
      }))
    )
    setActiveTabId(tabId)
  }, [])

  const closeTab = useCallback((tabId: string) => {
    let removedTab: Tab | undefined
    setTabs((prev) => {
      const target = prev.find((tab) => tab.id === tabId)
      removedTab = target
      const filtered = prev.filter((tab) => tab.id !== tabId)
      const closedIndex = prev.findIndex((tab) => tab.id === tabId)
      const fallback = filtered[closedIndex - 1] ?? filtered[0] ?? null
      const nextActiveId =
        activeTabIdRef.current === tabId ? fallback?.id ?? null : activeTabIdRef.current
      setActiveTabId(nextActiveId)
      return filtered.map((tab) => ({
        ...tab,
        isActive: tab.id === nextActiveId
      }))
    })

    if (removedTab && isFileTab(removedTab)) {
      api.removeTabState(tabId)
    }
  }, [])

  const updateTabContent = useCallback((tabId: string, content: string) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId && isFileTab(tab)
          ? {
              ...tab,
              content,
              isDirty: true
            }
          : tab
      )
    )
  }, [])

  const handleSave = useCallback(
    async (forceSaveAs: boolean) => {
      const currentTab = tabsRef.current.find(
        (tab): tab is FileTab => tab.id === activeTabIdRef.current && isFileTab(tab)
      )
      if (!currentTab) {
        return
      }

      const payload = {
        filePath: forceSaveAs ? undefined : currentTab.filePath,
        defaultPath: currentTab.filePath ?? buildDefaultFilename(currentTab.title),
        content: currentTab.content
      }

      const result: SaveFileResult = await api.saveFileDialog(payload)
      if (result.canceled || !result.filePath) {
        return
      }

      const newTitle = window.electron.path.basename(result.filePath)
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === currentTab.id && isFileTab(tab)
            ? {
                ...tab,
                filePath: result.filePath,
                title: newTitle,
                isDirty: false
              }
            : tab
        )
      )
      showStatus(`Saved to ${newTitle}`)
    },
    [showStatus]
  )

  const handleSearchResultSelect = useCallback(
    (result: SearchResultItem, match: SearchMatch) => {
      setTabs((prev) =>
        prev.map((tab) => ({
          ...tab,
          isActive: tab.id === result.tabId
        }))
      )
      setActiveTabId(result.tabId)
      requestAnimationFrame(() => focusLine(result.tabId, match.line, match.column))
    },
    [focusLine]
  )

  useEffect(() => {
    const disposers: RemoveListener[] = [
      api.onMenuNewFile(() => createNewTab()),
      api.onMenuOpenFile(() => openFiles()),
      api.onMenuSaveFile(() => handleSave(false)),
      api.onMenuSaveFileAs(() => handleSave(true)),
      api.onSearchResults((results) => {
        const totalMatches = results.reduce((acc, item) => acc + item.matches.length, 0)
        setTabs((prev) => {
          const withoutSearch = prev.filter((tab) => tab.id !== SEARCH_TAB_ID)
          const reset = withoutSearch.map((tab) => ({ ...tab, isActive: false }))
          const searchTab: SearchTab = {
            kind: 'search',
            id: SEARCH_TAB_ID,
            title: totalMatches ? `Search Results (${totalMatches})` : 'Search Results',
            results,
            totalMatches,
            isActive: true
          }
          return [...reset, searchTab]
        })
        setActiveTabId(SEARCH_TAB_ID)

        if (totalMatches > 0) {
          const fileCount = results.length
          showStatus(
            `Found ${totalMatches} match${totalMatches === 1 ? '' : 'es'} in ${fileCount} file${
              fileCount === 1 ? '' : 's'
            }`
          )
        } else {
          showStatus('No matches found')
        }
      }),
      api.onSearchNavigate(({ tabId, line, column }) => {
        const exists = tabsRef.current.some((tab) => tab.id === tabId)
        if (!exists) {
          return
        }
        setTabs((prev) =>
          prev.map((tab) => ({
            ...tab,
            isActive: tab.id === tabId
          }))
        )
        setActiveTabId(tabId)
        requestAnimationFrame(() => focusLine(tabId, line, column))
      })
    ]

    return () => {
      disposers.forEach((dispose) => dispose())
    }
  }, [createNewTab, focusLine, handleSave, openFiles, showStatus])

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId]
  )

  const renderWelcome = activeTab === null && tabs.length === 0

  const renderSearchContent = (tab: SearchTab): React.JSX.Element => {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-slate-200 bg-slate-50 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-800">Search Results</h2>
          <p className="text-sm text-slate-500">
            {tab.totalMatches
              ? `${tab.totalMatches} match${tab.totalMatches === 1 ? '' : 'es'} across ${tab.results.length} file${
                  tab.results.length === 1 ? '' : 's'
                }`
              : 'Try another search from the Search menu.'}
          </p>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tab.results.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center text-slate-500">
              <p>No matches were found for your last search.</p>
            </div>
          ) : (
            tab.results.map((result) => (
              <div
                key={result.tabId}
                className="mb-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow-md"
              >
                <div className="flex items-center justify-between text-sm font-semibold text-slate-700">
                  <span className="truncate">{result.title}</span>
                  <span className="text-slate-400">
                    {result.matches.length} match{result.matches.length === 1 ? '' : 'es'}
                  </span>
                </div>
                <div className="mt-3 space-y-2 text-xs">
                  {result.matches.map((match, index) => {
                    const key = `${result.tabId}-${match.line}-${index}`
                    const snippet = computeSnippet(match)
                    return (
                      <button
                        type="button"
                        key={key}
                        className="w-full rounded-lg border border-transparent bg-slate-50 px-3 py-2 text-left font-mono text-[11px] leading-5 text-slate-700 transition hover:border-sky-400 hover:bg-sky-50"
                        onClick={() => handleSearchResultSelect(result, match)}
                      >
                        <div className="flex justify-between text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                          <span>Line {match.line}</span>
                          <span>Col {match.column}</span>
                        </div>
                        <div className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap">
                          <span className="text-slate-400">{snippet.before}</span>
                          <span className="text-amber-500">{snippet.highlight}</span>
                          <span className="text-slate-400">{snippet.after}</span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex h-full flex-col bg-slate-50 text-slate-900">
      <nav className="flex items-center gap-2 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => switchTab(tab.id)}
            className={`group flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${
              tab.isActive
                ? 'bg-sky-500 text-white shadow-sm shadow-sky-100'
                : 'bg-slate-100 text-slate-500 hover:bg-sky-100 hover:text-sky-700'
            }`}
          >
            <span className="max-w-[200px] truncate">{tab.title}</span>
            {isFileTab(tab) && tab.isDirty ? (
              <span className="size-2 rounded-full bg-rose-500" />
            ) : null}
            <span
              role="button"
              aria-label={`Close ${tab.title}`}
              className="ml-1 text-xs text-slate-400 transition group-hover:text-sky-900"
              onClick={(event) => {
                event.stopPropagation()
                closeTab(tab.id)
              }}
            >
              ×
            </span>
          </button>
        ))}
      </nav>

      <main className="flex-1 overflow-hidden bg-slate-100 p-4">
        <div className="h-full overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          {renderWelcome ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-slate-500">
              <h1 className="text-3xl font-semibold text-slate-800">Welcome to LogEditor</h1>
              <p className="max-w-md text-sm text-slate-500">
                Use the File menu to create a blank log or open an existing one. When you are ready
                to search across files, open the Search window from the menu.
              </p>
            </div>
          ) : activeTab ? (
            isFileTab(activeTab) ? (
              <div className="relative h-full">
                <textarea
                  ref={(el) => {
                    editorRefs.current[activeTab.id] = el
                  }}
                  value={activeTab.content}
                  onChange={(event) => updateTabContent(activeTab.id, event.target.value)}
                  className="editor-scrollbar h-full w-full resize-none bg-transparent p-6 font-mono text-sm leading-6 text-slate-900 outline-none"
                  spellCheck={false}
                />
                <div
                  ref={(el) => {
                    highlightRefs.current[activeTab.id] = el
                  }}
                  className="pointer-events-none absolute left-0 right-0 bg-amber-200/60 opacity-0 transition-opacity"
                />
              </div>
            ) : (
              renderSearchContent(activeTab)
            )
          ) : (
            <div className="flex h-full items-center justify-center text-slate-500">
              Select a tab to begin editing.
            </div>
          )}
        </div>
      </main>

      {statusMessage ? (
        <div className="pointer-events-none absolute bottom-6 right-6 rounded-full bg-slate-900/85 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-slate-400/40">
          {statusMessage}
        </div>
      ) : null}
    </div>
  )
}

export default TabManager
