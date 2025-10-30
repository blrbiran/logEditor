import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  LogEditorApi,
  RemoveListener,
  SaveFileResult,
  SearchResultItem,
  SearchMatch,
  SearchRequest,
  SearchResponsePayload,
  ActiveContext
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
  request: SearchRequest
  parentSearchId?: string
  results: SearchResultItem[]
  totalMatches: number
  isActive: boolean
}

type WelcomeTab = {
  kind: 'welcome'
  id: string
  title: string
  isActive: boolean
}

type Tab = FileTab | SearchTab | WelcomeTab

const isFileTab = (tab: Tab): tab is FileTab => tab.kind === 'file'
const isWelcomeTab = (tab: Tab): tab is WelcomeTab => tab.kind === 'welcome'

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
const WELCOME_TAB_ID = 'welcome-tab'

const truncate = (value: string, maxLength = 32): string =>
  value.length > maxLength ? `${value.slice(0, maxLength)}...` : value

const describeScope = (request: SearchRequest): string =>
  request.scope?.kind === 'search' ? 'Refine' : 'Search'

const formatSearchQuery = (request: SearchRequest): string => {
  const trimmed = request.query.trim()
  if (!trimmed.length) {
    return '(empty)'
  }
  return request.isRegex ? `/${truncate(trimmed)}/` : `"${truncate(trimmed)}"`
}

const buildSearchTabTitle = (request: SearchRequest, totalMatches: number): string => {
  const baseTitle = `${describeScope(request)}: ${formatSearchQuery(request)}`
  return totalMatches ? `${baseTitle} (${totalMatches})` : baseTitle
}

const describeScopeDetail = (request: SearchRequest): string =>
  request.scope?.kind === 'search' ? 'Within previous search results' : 'Across open tabs'

const debugLog = (...args: unknown[]): void => {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.log('[TabManager]', ...args)
  }
}

const generateTabId = (): string => {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }
  return `tab-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
}

const createWelcomeTab = (isActive: boolean): WelcomeTab => ({
  kind: 'welcome',
  id: WELCOME_TAB_ID,
  title: 'Welcome',
  isActive
})

function TabManager(): React.JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>(() => [createWelcomeTab(true)])
  const [activeTabId, setActiveTabId] = useState<string | null>(WELCOME_TAB_ID)

  const tabsRef = useRef<Tab[]>([createWelcomeTab(true)])
  const activeTabIdRef = useRef<string | null>(WELCOME_TAB_ID)
  const untitledCounterRef = useRef<number>(1)
  const editorRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})
  const highlightRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const highlightInfoRef = useRef<{ tabId: string; line: number } | null>(null)
  const highlightTimeoutRef = useRef<number | null>(null)
  const searchContainerRef = useRef<HTMLDivElement | null>(null)
  const searchObserverRef = useRef<MutationObserver | null>(null)

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
  }, [])

  useEffect(() => {
    debugLog(
      'tabs changed',
      tabs.map((tab) => ({
        id: tab.id,
        kind: tab.kind,
        title: tab.title,
        isActive: tab.isActive,
        isDirty: isFileTab(tab) ? tab.isDirty : undefined,
        filePath: isFileTab(tab) ? tab.filePath : undefined,
        contentLength: isFileTab(tab) ? tab.content.length : undefined,
        contentPreview: isFileTab(tab) ? tab.content.slice(0, 80) : undefined
      }))
    )
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
        debugLog('cleanup highlight timeout')
        window.clearTimeout(highlightTimeoutRef.current)
      }
      tabsRef.current
        .filter((tab): tab is SearchTab => tab.kind === 'search')
        .forEach((searchTab) => {
          debugLog('cleanup disposing search results', searchTab.id)
          api.disposeSearchResults(searchTab.id)
        })
    }
  }, [])

  const focusLine = useCallback((tabId: string, line: number, column = 1) => {
    const textarea = editorRefs.current[tabId]
    const overlay = highlightRefs.current[tabId]
    if (!textarea || !overlay) {
      debugLog('focusLine skipped: missing elements', { tabId })
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
      debugLog('clear existing highlight timeout', highlightTimeoutRef.current)
      window.clearTimeout(highlightTimeoutRef.current)
    }
    highlightTimeoutRef.current = window.setTimeout(() => {
      debugLog('hide highlight', { tabId, line: targetLine })
      overlayEl.style.opacity = '0'
      highlightInfoRef.current = null
    }, 2000)
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
        filePath: undefined,
        isDirty: false,
        isActive: true
      }
      const nextTabs = [...reset, newTab]
      debugLog('createNewTab:setTabs', {
        previousIds: prev.map((tab) => tab.id),
        nextIds: nextTabs.map((tab) => tab.id)
      })
      return nextTabs
    })
    updateActiveTab(id)
  }, [updateActiveTab])

  const openFiles = useCallback(async () => {
    const files = await api.openFileDialog()
    if (!files.length) {
      debugLog('openFiles canceled or empty')
      return
    }

    debugLog('openFiles received', files.map((file) => file.filePath))
    const currentTabs = tabsRef.current
    let updatedTabs = currentTabs.map((tab) => ({ ...tab, isActive: false }))
    let activeId = activeTabIdRef.current

    files.forEach((file) => {
      const existingIndex = updatedTabs.findIndex(
        (tab) => isFileTab(tab) && tab.filePath === file.filePath
      )
      if (existingIndex >= 0) {
        const existingTab = updatedTabs[existingIndex] as FileTab
        debugLog('openFiles refreshing existing tab', {
          filePath: file.filePath,
          tabId: existingTab.id
        })
        const refreshedTab: FileTab = {
          ...existingTab,
          content: file.content,
          isDirty: false,
          isActive: true
        }
        updatedTabs[existingIndex] = refreshedTab
        activeId = refreshedTab.id
      } else {
        const id = generateTabId()
        const title = window.electron.path.basename(file.filePath)
        debugLog('openFiles creating new tab', {
          filePath: file.filePath,
          tabId: id,
          title
        })
        const newTab: FileTab = {
          kind: 'file',
          id,
          title,
          filePath: file.filePath,
          content: file.content,
          isDirty: false,
          isActive: true
        }
        updatedTabs = [...updatedTabs, newTab]
        activeId = id
      }
    })

    const nextActiveTabId = activeId ?? updatedTabs.find((tab) => tab.isActive)?.id ?? null
    debugLog('openFiles computed result', {
      nextActiveTabId,
      tabIds: updatedTabs.map((tab) => tab.id)
    })

    tabsRef.current = updatedTabs
    setTabs(updatedTabs)
    updateActiveTab(nextActiveTabId)
  }, [updateActiveTab])

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
    let removedTab: Tab | undefined
    setTabs((prev) => {
      const target = prev.find((tab) => tab.id === tabId)
      removedTab = target
      const remaining = prev.filter((tab) => tab.id !== tabId)
      if (remaining.length === 0) {
        const welcome = createWelcomeTab(true)
        updateActiveTab(welcome.id)
        return [welcome]
      }

      const closedIndex = prev.findIndex((tab) => tab.id === tabId)
      const fallback = remaining[closedIndex - 1] ?? remaining[0] ?? null
      const nextActiveId =
        activeTabIdRef.current === tabId ? fallback?.id ?? null : activeTabIdRef.current
      updateActiveTab(nextActiveId)
      return remaining.map((tab) => ({
        ...tab,
        isActive: tab.id === nextActiveId
      }))
    })

    if (removedTab && isFileTab(removedTab)) {
      debugLog('closeTab removing tab state', removedTab.id)
      api.removeTabState(tabId)
    } else if (removedTab && removedTab.kind === 'search') {
      debugLog('closeTab disposing search results', removedTab.id)
      api.disposeSearchResults(removedTab.id)
    }
  }, [updateActiveTab])

  const updateTabContent = useCallback((tabId: string, content: string) => {
    debugLog('updateTabContent', { tabId, length: content.length })
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

  const closeActiveTab = useCallback(() => {
    const currentId = activeTabIdRef.current
    if (!currentId) {
      debugLog('closeActiveTab skipped: no active tab')
      return
    }
    const currentTab = tabsRef.current.find((tab) => tab.id === currentId)
    if (!currentTab || isWelcomeTab(currentTab)) {
      debugLog('closeActiveTab skipped: welcome or missing', currentId)
      return
    }
    closeTab(currentId)
  }, [closeTab])

  const handleSave = useCallback(
    async (forceSaveAs: boolean) => {
      const currentTab = tabsRef.current.find(
        (tab): tab is FileTab => tab.id === activeTabIdRef.current && isFileTab(tab)
      )
      if (!currentTab) {
        debugLog('handleSave skipped: no current file tab')
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
            ? {
                ...tab,
                filePath: result.filePath,
                title: newTitle,
                isDirty: false
              }
            : tab
        )
      )
    },
    []
  )

  const handleSearchResultSelect = useCallback(
    (result: SearchResultItem, match: SearchMatch) => {
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
      requestAnimationFrame(() => focusLine(result.tabId, match.line, match.column))
    },
    [focusLine, updateActiveTab]
  )

  useEffect(() => {
    const disposers: RemoveListener[] = [
      api.onMenuNewFile(() => createNewTab()),
      api.onMenuOpenFile(() => openFiles()),
      api.onMenuSaveFile(() => handleSave(false)),
      api.onMenuSaveFileAs(() => handleSave(true)),
      api.onMenuCloseTab(() => closeActiveTab()),
      api.onSearchResults((payload: SearchResponsePayload) => {
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
        updateActiveTab(tabId)
        requestAnimationFrame(() => focusLine(tabId, line, column))
      })
    ]

    return () => {
      disposers.forEach((dispose) => dispose())
    }
  }, [closeActiveTab, createNewTab, focusLine, handleSave, openFiles])

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId]
  )

  useEffect(() => {
    let context: ActiveContext
    if (!activeTab) {
      context = { kind: 'welcome' }
    } else if (isFileTab(activeTab)) {
      context = { kind: 'file', tabId: activeTab.id }
    } else if (activeTab.kind === 'search') {
      context = { kind: 'search', searchId: activeTab.id }
    } else {
      context = { kind: 'welcome' }
    }
    debugLog('updateActiveContext', context)
    api.updateActiveContext(context)
  }, [activeTab])

  useEffect(() => {
    if (activeTab && activeTab.kind === 'search') {
      debugLog('searchTab snapshot', {
        activeSearchId: activeTab.id,
        totalMatches: activeTab.totalMatches,
        results: activeTab.results.map((item) => ({
          title: item.title,
          matches: item.matches.length,
          matchPreview: item.matches[0]
            ? { line: item.matches[0].line, column: item.matches[0].column, preview: item.matches[0].preview }
            : null
        }))
      })
      if (searchContainerRef.current) {
        searchContainerRef.current.style.opacity = '1'
      }
    }
  }, [activeTab])

  useEffect(() => {
    const container = searchContainerRef.current
    if (!container || !activeTab || activeTab.kind !== 'search') {
      searchObserverRef.current?.disconnect()
      searchObserverRef.current = null
      return
    }

    const enforceOpacity = () => {
      const currentOpacity = container.style.opacity
      if (currentOpacity !== '' && currentOpacity !== '1') {
        debugLog('correcting search container opacity', currentOpacity)
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
  }, [activeTabId])

  useEffect(() => {
    if (activeTab) {
      debugLog('activeTab updated', {
        activeTabId,
        title: activeTab.title,
        kind: activeTab.kind,
        contentLength: isFileTab(activeTab) ? activeTab.content.length : undefined,
        contentPreview: isFileTab(activeTab) ? activeTab.content.slice(0, 80) : undefined
      })
    } else {
      debugLog('activeTab updated', { activeTabId, title: null })
    }
  }, [activeTabId, activeTab])

  const renderWelcomeContent = (): React.JSX.Element => (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-slate-500">
      <h1 className="text-3xl font-semibold text-slate-800">Welcome to LogEditor</h1>
      <p className="max-w-md text-sm text-slate-500">
        Use the File menu to create a blank log or open an existing one. When you are ready to
        search across files, open the Search window from the menu.
      </p>
    </div>
  )

  const renderSearchContent = (tab: SearchTab): React.JSX.Element => {
    const summary = tab.totalMatches
      ? `${tab.totalMatches} match${tab.totalMatches === 1 ? '' : 'es'} across ${tab.results.length} file${
          tab.results.length === 1 ? '' : 's'
        }`
      : 'No matches yet — try adjusting your query.'

    return (
      <div className="flex h-full flex-col bg-slate-50">
        <div className="border-b border-slate-200 bg-white/70 px-6 py-4">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-500">
            {tab.request.scope?.kind === 'search' ? 'Nested search' : 'Search results'}
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-800">
            {formatSearchQuery(tab.request)}
          </h2>
          <p className="mt-1 text-xs text-slate-400">{describeScopeDetail(tab.request)}</p>
          <p className="mt-2 text-sm text-slate-500">{summary}</p>
        </div>
        <div
          ref={searchContainerRef}
          className="flex-1 overflow-y-auto px-6 py-5"
        >
          {tab.results.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-8 py-10 text-center shadow-sm">
                <p className="text-sm font-semibold text-slate-600">No matches were found.</p>
                <p className="mt-2 text-xs text-slate-400">Try another keyword or enable regex.</p>
              </div>
            </div>
          ) : (
            tab.results.map((result) => {
              return (
                <div
                  key={result.tabId}
                  className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-sky-300 hover:shadow-md"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-slate-100 pb-4">
                    <p className="max-w-[260px] truncate text-sm font-semibold text-slate-800">
                      {result.title}
                    </p>
                    <span className="rounded-full bg-sky-50 px-3 py-1 text-xs font-medium text-sky-600">
                      {result.matches.length} match{result.matches.length === 1 ? '' : 'es'}
                    </span>
                  </div>
                  <div className="mt-4 space-y-2 text-xs">
                    {result.matches.map((match, index) => {
                      const key = `${result.tabId}-${match.line}-${index}`
                      const snippet = computeSnippet(match)
                      debugLog('rendering search match', {
                        tabTitle: result.title,
                        matchLine: match.line,
                        matchColumn: match.column,
                        snippet
                      })
                      return (
                        <button
                          type="button"
                          key={key}
                          className="group w-full rounded-xl border border-slate-200 bg-slate-50 p-3 text-left transition hover:border-sky-300 hover:bg-white"
                          onClick={() => handleSearchResultSelect(result, match)}
                        >
                          <div className="flex items-center gap-3 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                            <span>Line {match.line}</span>
                            <span>•</span>
                            <span>Col {match.column}</span>
                          </div>
                          <div className="mt-2 rounded-lg bg-slate-900 px-3 py-2 font-mono text-xs leading-6 text-slate-100 shadow transition group-hover:bg-slate-900/95">
                            <span className="text-slate-300">{snippet.before || ' '}</span>
                            <span className="rounded bg-amber-300 px-1 font-semibold text-slate-900">
                              {snippet.highlight || '(empty match)'}
                            </span>
                            <span className="text-slate-300">{snippet.after || ' '}</span>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex h-full flex-col bg-slate-50 text-slate-900">
      <nav
        className="flex items-center gap-2 overflow-x-auto border-b border-slate-200 bg-white px-2 py-2"
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
            className={`group flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition ${
              tab.isActive
                ? 'border-sky-500 bg-white text-sky-700 shadow'
                : 'border-transparent bg-slate-100 text-slate-500 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700'
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
          {activeTab ? (
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
              isWelcomeTab(activeTab) ? renderWelcomeContent() : renderSearchContent(activeTab)
            )
          ) : (
            renderWelcomeContent()
          )}
        </div>
      </main>
    </div>
  )
}

export default TabManager
