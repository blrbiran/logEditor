import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  LogEditorApi,
  RemoveListener,
  SaveFileResult,
  SearchResultItem,
  SearchMatch
} from '../env'

type Tab = {
  id: string
  title: string
  filePath?: string
  content: string
  isDirty: boolean
  isActive: boolean
}

const api: LogEditorApi = window.api

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

function TabManager(): React.JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([])
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
    tabs.forEach((tab) => {
      api.syncTabState({
        id: tab.id,
        title: tab.title,
        filePath: tab.filePath,
        content: tab.content
      })
    })
  }, [tabs])

  useEffect(() => {
    const textarea = activeTabId ? editorRefs.current[activeTabId] : null
    const overlay = activeTabId ? highlightRefs.current[activeTabId] : null
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
      return [
        ...reset,
        {
          id,
          title,
          content: '',
          filePath: undefined,
          isDirty: false,
          isActive: true
        }
      ]
    })
    setActiveTabId(id)
    showStatus(`Created ${title}`)
  }, [showStatus])

  const openFiles = useCallback(async () => {
    const files = await api.openFileDialog()
    if (!files.length) {
      return
    }

    setTabs((prev) => {
      let nextTabs = prev.map((tab) => ({ ...tab }))
      let nextActiveId = activeTabIdRef.current

      files.forEach((file) => {
        const existingIndex = nextTabs.findIndex((tab) => tab.filePath === file.filePath)
        if (existingIndex >= 0) {
          nextTabs = nextTabs.map((tab, idx) => ({
            ...tab,
            isActive: idx === existingIndex
          }))
          nextTabs[existingIndex] = {
            ...nextTabs[existingIndex],
            content: file.content,
            isDirty: false
          }
          nextActiveId = nextTabs[existingIndex].id
        } else {
          const id = crypto.randomUUID()
          const title = window.electron.path.basename(file.filePath)
          const newTab: Tab = {
            id,
            title,
            filePath: file.filePath,
            content: file.content,
            isDirty: false,
            isActive: true
          }
          nextTabs = nextTabs.map((tab) => ({ ...tab, isActive: false }))
          nextTabs = [...nextTabs, newTab]
          nextActiveId = id
        }
      })

      setActiveTabId(nextActiveId)
      return nextTabs
    })
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
    setTabs((prev) => {
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
    api.removeTabState(tabId)
  }, [])

  const updateTabContent = useCallback((tabId: string, content: string) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId
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
      const currentTab = tabsRef.current.find((tab) => tab.id === activeTabIdRef.current)
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
          tab.id === currentTab.id
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
        setSearchResults(results)
        if (results.length) {
          const totalMatches = results.reduce(
            (acc, item) => acc + item.matches.length,
            0
          )
          showStatus(`Found ${totalMatches} match${totalMatches === 1 ? '' : 'es'}`)
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

  const totalMatches = useMemo(
    () => searchResults.reduce((acc, item) => acc + item.matches.length, 0),
    [searchResults]
  )

  const renderWelcome = activeTab === null && tabs.length === 0

  return (
    <div className="flex h-full bg-slate-950 text-slate-100">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => createNewTab()}
              className="rounded bg-emerald-600 px-3 py-1 text-sm font-medium text-white transition hover:bg-emerald-500"
              type="button"
            >
              New
            </button>
            <button
              onClick={() => openFiles()}
              className="rounded border border-slate-700 px-3 py-1 text-sm text-slate-200 transition hover:border-slate-500"
              type="button"
            >
              Open
            </button>
            <button
              onClick={() => handleSave(false)}
              className="rounded border border-slate-700 px-3 py-1 text-sm text-slate-200 transition hover:border-slate-500"
              type="button"
              disabled={!activeTab}
            >
              Save
            </button>
            <button
              onClick={() => api.openSearchWindow()}
              className="rounded border border-slate-700 px-3 py-1 text-sm text-slate-200 transition hover:border-slate-500"
              type="button"
            >
              Search
            </button>
          </div>
          {statusMessage ? (
            <span className="text-xs text-slate-400">{statusMessage}</span>
          ) : (
            <span className="text-xs text-slate-500">
              {activeTab?.filePath ?? 'No file selected'}
            </span>
          )}
        </header>

        <nav className="flex items-center gap-2 overflow-x-auto border-b border-slate-800 px-2 py-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => switchTab(tab.id)}
              className={`group flex items-center gap-2 rounded px-3 py-1.5 text-sm transition ${
                tab.isActive
                  ? 'bg-slate-800 text-white'
                  : 'bg-transparent text-slate-400 hover:bg-slate-800/60 hover:text-slate-100'
              }`}
            >
              <span className="truncate max-w-[180px]">{tab.title}</span>
              {tab.isDirty ? <span className="size-2 rounded-full bg-rose-500" /> : null}
              <span
                role="button"
                aria-label={`Close ${tab.title}`}
                className="ml-1 text-xs text-slate-500 transition group-hover:text-red-400"
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

        <main className="relative flex min-h-0 flex-1">
          {renderWelcome ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-slate-400">
              <h1 className="text-2xl font-semibold text-slate-100">Log Editor</h1>
              <p className="max-w-sm text-sm text-slate-400">
                Create or open log files, edit them with ease, and search across every open file
                instantly.
              </p>
              <div className="mt-4 flex gap-3">
                <button
                  onClick={() => createNewTab()}
                  className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500"
                >
                  Create Blank File
                </button>
                <button
                  onClick={() => openFiles()}
                  className="rounded border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-500"
                >
                  Open Existing
                </button>
              </div>
            </div>
          ) : activeTab ? (
            <div className="flex flex-1 flex-col">
              <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2 text-xs text-slate-500">
                <span>{activeTab.filePath ?? 'Unsaved file'}</span>
                {activeTab.isDirty ? <span className="text-rose-400">Unsaved changes</span> : null}
              </div>
              <div className="relative flex-1">
                <textarea
                  ref={(el) => {
                    editorRefs.current[activeTab.id] = el
                  }}
                  value={activeTab.content}
                  onChange={(event) => updateTabContent(activeTab.id, event.target.value)}
                  className="editor-scrollbar h-full w-full resize-none bg-slate-950 p-4 font-mono text-sm leading-6 text-slate-100 focus:outline-none"
                  spellCheck={false}
                />
                <div
                  ref={(el) => {
                    highlightRefs.current[activeTab.id] = el
                  }}
                  className="pointer-events-none absolute left-0 right-0 bg-amber-400/30 opacity-0"
                />
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-slate-500">
              Select a tab to begin editing.
            </div>
          )}
        </main>
      </div>

      <aside className="flex w-80 min-w-[18rem] flex-col border-l border-slate-800 bg-slate-900/80">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-200">Search Results</h2>
            <p className="text-xs text-slate-500">
              {totalMatches
                ? `${totalMatches} match${totalMatches === 1 ? '' : 'es'}`
                : 'No active search'}
            </p>
          </div>
          <button
            type="button"
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 transition hover:border-slate-500"
            onClick={() => api.openSearchWindow()}
          >
            New Search
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {searchResults.length === 0 ? (
            <p className="text-xs text-slate-500">
              Use the search window to look across every open file. Results will appear here.
            </p>
          ) : (
            searchResults.map((result) => (
              <div
                key={result.tabId}
                className="mb-4 rounded border border-slate-800 bg-slate-900/60 p-3 shadow-sm shadow-slate-950"
              >
                <div className="flex items-center justify-between text-xs font-semibold text-slate-200">
                  <span className="truncate">{result.title}</span>
                  <span className="text-slate-400">{result.matches.length}</span>
                </div>
                <div className="mt-2 space-y-2 text-xs">
                  {result.matches.map((match, index) => {
                    const key = `${result.tabId}-${match.line}-${index}`
                    const snippet = computeSnippet(match)
                    return (
                      <button
                        type="button"
                        key={key}
                        className="w-full rounded border border-transparent bg-slate-900/40 px-3 py-2 text-left transition hover:border-emerald-600 hover:bg-slate-800/60"
                        onClick={() => handleSearchResultSelect(result, match)}
                      >
                        <div className="flex justify-between text-[11px] uppercase tracking-wide text-slate-500">
                          <span>Line {match.line}</span>
                          <span>Col {match.column}</span>
                        </div>
                        <div className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] leading-5 text-slate-300">
                          <span className="text-slate-500">{snippet.before}</span>
                          <span className="text-amber-300">{snippet.highlight}</span>
                          <span className="text-slate-500">{snippet.after}</span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  )
}

export default TabManager
