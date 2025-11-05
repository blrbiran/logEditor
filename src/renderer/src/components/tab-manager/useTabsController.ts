import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  LogEditorApi,
  OpenedFile,
  SaveFileResult,
  SearchMatch,
  SearchResponsePayload,
  SearchResultItem,
  ActiveContext
} from '@renderer/env'
import { buildDefaultFilename, generateTabId } from './helpers'
import { WELCOME_TAB_ID, isFileTab, isSearchTab, type FileTab, type SearchTab, type Tab, type WelcomeTab } from './tab-types'
import { buildSearchTabTitle } from './search-utils'

const api: LogEditorApi = window.api
const DEFAULT_CHUNK_SIZE = 512 * 1024

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
  closeActiveTab(): void
  updateTabContent(tabId: string, content: string): void
  handleSave(forceSaveAs: boolean): Promise<void>
  handleSearchResultSelect(result: SearchResultItem, match: SearchMatch): void
  loadMoreContent(tabId: string): Promise<void>
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
  const activationStackRef = useRef<string[]>([WELCOME_TAB_ID])
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
    if (id) {
      activationStackRef.current = activationStackRef.current.filter((tabId) => tabId !== id)
      activationStackRef.current.push(id)
    }
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
        content: tab.content,
        size: tab.size,
        isTruncated: tab.isTruncated,
        loadedRange: tab.loadedRange
      })
    })
  }, [tabs])

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
          const refreshedTab: FileTab = {
            ...existingTab,
            content: file.content,
            title: fileName,
            filePath: filePath && filePath.length > 0 ? filePath : existingTab.filePath,
            size: file.size ?? loadedBytes,
            loadedRange: { start: 0, end: loadedBytes },
            chunkSize,
            isTruncated: Boolean(file.isTruncated && filePath),
            isReadOnly: Boolean(file.isTruncated && filePath),
            isLoadingMore: false,
            isDirty: false,
            isActive: true
          }
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
          const newTab: FileTab = {
            kind: 'file',
            id,
            title: fileName,
            filePath: filePath && filePath.length > 0 ? filePath : undefined,
            content: file.content,
            size: file.size ?? loadedBytes,
            loadedRange: { start: 0, end: loadedBytes },
            chunkSize,
            isTruncated: Boolean(file.isTruncated && filePath),
            isReadOnly: Boolean(file.isTruncated && filePath),
            isLoadingMore: false,
            isDirty: false,
            isActive: true
          }
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
    [updateActiveTab]
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
        return {
          ...tab,
          content,
          size: content.length,
          loadedRange: { start: 0, end: content.length },
          isTruncated: false,
          isDirty: true
        }
      })
    )
  }, [])

  const closeActiveTab = useCallback(() => {
    const currentId = activeTabIdRef.current
    if (!currentId) {
      debugLog('closeActiveTab skipped: no active tab')
      return
    }
    const currentTab = tabsRef.current.find((tab) => tab.id === currentId)
    if (!currentTab) {
      debugLog('closeActiveTab skipped: missing tab', currentId)
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
                size: tab.content.length,
                loadedRange: { start: 0, end: tab.content.length },
                isTruncated: false,
                isReadOnly: false,
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

  const loadMoreContent = useCallback(
    async (tabId: string) => {
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
            return {
              ...tab,
              content: appendedContent,
              size: range.totalSize,
              loadedRange: { start: 0, end: range.end },
              isTruncated: range.hasMore,
              isReadOnly: range.hasMore ? tab.isReadOnly : false,
              isLoadingMore: false
            }
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
    [api]
  )

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
    openFilesFromPaths,
    openFilesFromContent,
    switchTab,
    closeTab,
    closeActiveTab,
    updateTabContent,
    handleSave,
    handleSearchResultSelect,
    loadMoreContent
  }
}
