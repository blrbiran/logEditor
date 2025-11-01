import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { LogEditorApi, SearchMatch, SearchResultItem } from '@renderer/env'
import { SearchResultsPanel } from './tab-manager/SearchResultsPanel'
import { LINE_NUMBER_GUTTER_WIDTH } from './tab-manager/constants'
import { clamp } from './tab-manager/helpers'
import { useTabsController } from './tab-manager/useTabsController'
import {
  isFileTab,
  isSearchTab,
  isWelcomeTab,
  type SearchTab,
  type Tab
} from './tab-manager/tab-types'

const api: LogEditorApi = window.api

function TabManager(): React.JSX.Element {
  const editorRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})
  const highlightRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const lineNumberRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const highlightInfoRef = useRef<{ tabId: string; line: number } | null>(null)
  const highlightTimeoutRef = useRef<number | null>(null)
  const searchContainerRef = useRef<HTMLDivElement | null>(null)
  const searchObserverRef = useRef<MutationObserver | null>(null)

  const {
    tabs,
    activeTabId,
    activeTab,
    tabsRef,
    activeTabIdRef,
    createNewTab,
    switchTab,
    closeTab,
    updateTabContent,
    handleSearchResultSelect
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
      const lineNumberEl = lineNumberRefs.current[tabId] ?? null
      if (lineNumberEl) {
        lineNumberEl.style.transform = `translateY(-${textarea.scrollTop}px)`
      }

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
    []
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
      const lineNumberEl = lineNumberRefs.current[activeTabRecord.id] ?? null
      if (lineNumberEl) {
        lineNumberEl.style.transform = `translateY(-${textarea.scrollTop}px)`
      }
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
  }, [activeTabId, activeTabIdRef, tabsRef])

  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) {
        window.clearTimeout(highlightTimeoutRef.current)
      }
      searchObserverRef.current?.disconnect()
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

  const activeFileLineNumbers = useMemo(() => {
    if (!activeTab || !isFileTab(activeTab)) {
      return []
    }
    return activeTab.content.split(/\r?\n/).map((_, index) => index + 1)
  }, [activeTab])

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
      requestAnimationFrame(() => focusLine(result.tabId, match.line, match.column))
    },
    [focusLine, handleSearchResultSelect]
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
      return (
        <div className="relative h-full">
          <div className="flex h-full">
            <div className="relative h-full shrink-0 overflow-hidden border-r border-slate-200 bg-slate-100/80">
              <div
                ref={(el) => {
                  lineNumberRefs.current[tab.id] = el
                  if (el) {
                    const textarea = editorRefs.current[tab.id]
                    if (textarea) {
                      el.style.transform = `translateY(-${textarea.scrollTop}px)`
                    }
                  }
                }}
                className="w-14 px-3 py-0 text-right font-mono text-xs leading-6 text-slate-400 will-change-transform"
              >
                {activeFileLineNumbers.map((lineNumber) => (
                  <span key={`${tab.id}-line-${lineNumber}`} className="block leading-6">
                    {lineNumber}
                  </span>
                ))}
              </div>
            </div>
            <textarea
              ref={(el) => {
                editorRefs.current[tab.id] = el
              }}
              value={tab.content}
              onChange={(event) => updateTabContent(tab.id, event.target.value)}
              className="editor-scrollbar h-full w-full resize-none bg-transparent p-0 font-mono text-sm leading-6 text-slate-900 outline-none"
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
            {isFileTab(tab) && tab.isDirty ? <span className="size-2 rounded-full bg-rose-500" /> : null}
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

      <main className="flex-1 overflow-hidden bg-slate-100">
        <div className="h-full overflow-hidden border border-slate-200 bg-white shadow-sm">
          {renderActiveContent(activeTab)}
        </div>
      </main>
    </div>
  )
}

export default TabManager
