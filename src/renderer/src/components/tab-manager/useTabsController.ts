import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  LogEditorApi,
  SaveFileResult,
  SearchMatch,
  SearchResponsePayload,
  SearchResultItem,
  ActiveContext
} from '@renderer/env'
import { buildDefaultFilename, generateTabId } from './helpers'
import {
  WELCOME_TAB_ID,
  isFileTab,
  isSearchTab,
  isWelcomeTab,
  type FileTab,
  type SearchTab,
  type Tab,
  type WelcomeTab
} from './tab-types'
import { buildSearchTabTitle } from './search-utils'

const api: LogEditorApi = window.api

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
  switchTab(tabId: string): void
  closeTab(tabId: string): void
  closeActiveTab(): void
  updateTabContent(tabId: string, content: string): void
  handleSave(forceSaveAs: boolean): Promise<void>
  handleSearchResultSelect(result: SearchResultItem, match: SearchMatch): void
}

const debugLog = (...args: unknown[]): void => {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.log('[TabManager]', ...args)
  }
}

export const useTabsController = (): UseTabsControllerResult => {
  const [tabs, setTabs] = useState<Tab[]>(() => [createWelcomeTab(true)])
  const [activeTabId, setActiveTabId] = useState<string | null>(WELCOME_TAB_ID)

  const tabsRef = useRef<Tab[]>([createWelcomeTab(true)])
  const activeTabIdRef = useRef<string | null>(WELCOME_TAB_ID)
  const untitledCounterRef = useRef<number>(1)

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
      const existingIndex = updatedTabs.findIndex((tab) => isFileTab(tab) && tab.filePath === file.filePath)
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
    } else if (removedTab && isSearchTab(removedTab)) {
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
      const currentTab = tabsRef.current.find((tab): tab is FileTab => tab.id === activeTabIdRef.current && isFileTab(tab))
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

  useEffect(() => {
    const disposers = [
      api.onMenuNewFile(() => createNewTab()),
      api.onMenuOpenFile(() => openFiles()),
      api.onMenuSaveFile(() => void handleSave(false)),
      api.onMenuSaveFileAs(() => void handleSave(true)),
      api.onMenuCloseTab(() => closeActiveTab()),
      api.onSearchResults((payload: SearchResponsePayload) => handleSearchResults(payload))
    ]

    return () => {
      disposers.forEach((dispose) => dispose())
    }
  }, [closeActiveTab, createNewTab, handleSave, handleSearchResults, openFiles, updateActiveTab])

  return {
    tabs,
    activeTabId,
    activeTab,
    tabsRef,
    activeTabIdRef,
    createNewTab,
    openFiles,
    switchTab,
    closeTab,
    closeActiveTab,
    updateTabContent,
    handleSave,
    handleSearchResultSelect
  }
}
