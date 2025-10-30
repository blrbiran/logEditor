import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { basename } from 'path'

type RemoveListener = () => void

type SearchMatch = {
  line: number
  column: number
  match: string
  preview: string
}

type SearchResultItem = {
  tabId: string
  title: string
  filePath?: string
  matches: SearchMatch[]
}

type SearchScope =
  | {
      kind: 'workspace'
    }
  | {
      kind: 'search'
      searchId: string
    }

type SearchRequest = {
  query: string
  isRegex: boolean
  matchCase: boolean
  scope?: SearchScope
  excludeQuery?: string
}

type SearchResponsePayload = {
  searchId: string
  parentSearchId?: string
  request: SearchRequest
  results: SearchResultItem[]
}

type SaveFilePayload = {
  filePath?: string
  defaultPath?: string
  content: string
}

type SearchableTab = {
  id: string
  title: string
  filePath?: string
  content: string
}

type ActiveContext =
  | { kind: 'welcome' }
  | { kind: 'file'; tabId: string }
  | { kind: 'search'; searchId: string }

const subscribe = <Payload>(
  channel: string,
  listener: (payload: Payload) => void
): RemoveListener => {
  const handler = (_event: IpcRendererEvent, payload: Payload) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const invoke = <Result>(channel: string, payload?: unknown): Promise<Result> => {
  return ipcRenderer.invoke(channel, payload)
}

// Custom APIs for renderer
const api = {
  openFileDialog: (): Promise<{ filePath: string; content: string }[]> =>
    invoke('open-file-dialog'),
  saveFileDialog: (payload: SaveFilePayload): Promise<{ canceled: boolean; filePath?: string }> =>
    invoke('save-file-dialog', payload),
  performSearch: (payload: SearchRequest): Promise<SearchResponsePayload> =>
    invoke('perform-search', payload),
  syncTabState: (tab: SearchableTab): void => {
    ipcRenderer.send('sync-tab-state', tab)
  },
  removeTabState: (tabId: string): void => {
    ipcRenderer.send('remove-tab-state', tabId)
  },
  emitSearchResults: (payload: SearchResponsePayload): void => {
    ipcRenderer.send('display-search-results', payload)
  },
  emitNavigateToLine: (payload: { tabId: string; line: number; column?: number }): void => {
    ipcRenderer.send('navigate-to-file-line', payload)
  },
  openSearchWindow: (): void => {
    ipcRenderer.send('open-search-window')
  },
  disposeSearchResults: (searchId: string): void => {
    ipcRenderer.send('dispose-search-results', searchId)
  },
  updateActiveContext: (context: ActiveContext): void => {
    ipcRenderer.send('update-active-context', context)
  },
  onMenuNewFile: (listener: () => void): RemoveListener => subscribe('menu:new-file', listener),
  onMenuOpenFile: (listener: () => void): RemoveListener => subscribe('menu:open-file', listener),
  onMenuSaveFile: (listener: () => void): RemoveListener => subscribe('menu:save-file', listener),
  onMenuSaveFileAs: (listener: () => void): RemoveListener =>
    subscribe('menu:save-file-as', listener),
  onMenuCloseTab: (listener: () => void): RemoveListener => subscribe('menu:close-tab', listener),
  onSearchResults: (listener: (payload: SearchResponsePayload) => void): RemoveListener =>
    subscribe('search:results', listener),
  onSearchNavigate: (
    listener: (payload: { tabId: string; line: number; column?: number }) => void
  ): RemoveListener => subscribe('search:navigate', listener),
  onSearchContext: (listener: (payload: ActiveContext) => void): RemoveListener =>
    subscribe('search:context', listener)
}

const extendedElectronApi = {
  ...electronAPI,
  path: {
    basename
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', extendedElectronApi)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = extendedElectronApi
  // @ts-ignore (define in dts)
  window.api = api
}
