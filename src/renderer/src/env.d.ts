/// <reference types="vite/client" />

import type { ElectronAPI } from '@electron-toolkit/preload'

export type SearchMatch = {
  line: number
  column: number
  match: string
  preview: string
}

export type SearchResultItem = {
  tabId: string
  title: string
  filePath?: string
  matches: SearchMatch[]
}

export type SearchScope =
  | {
      kind: 'workspace'
    }
  | {
      kind: 'search'
      searchId: string
    }

export type SearchRequest = {
  query: string
  isRegex: boolean
  matchCase: boolean
  scope?: SearchScope
  excludeQuery?: string
  dedupeLines?: boolean
}

export type SearchResponsePayload = {
  searchId: string
  parentSearchId?: string
  request: SearchRequest
  results: SearchResultItem[]
}

export type SearchableTab = {
  id: string
  title: string
  filePath?: string
  content: string
}

export type SaveFilePayload = {
  filePath?: string
  defaultPath?: string
  content: string
}

export type SaveFileResult = {
  canceled: boolean
  filePath?: string
}

export type RemoveListener = () => void

export type ActiveContext =
  | { kind: 'welcome' }
  | { kind: 'file'; tabId: string }
  | { kind: 'search'; searchId: string }

export interface LogEditorApi {
  openFileDialog(): Promise<{ filePath: string; content: string }[]>
  saveFileDialog(payload: SaveFilePayload): Promise<SaveFileResult>
  performSearch(payload: SearchRequest): Promise<SearchResponsePayload>
  syncTabState(tab: SearchableTab): void
  removeTabState(tabId: string): void
  emitSearchResults(payload: SearchResponsePayload): void
  emitNavigateToLine(payload: { tabId: string; line: number; column?: number }): void
  openSearchWindow(): void
  focusMainWindow(): void
  disposeSearchResults(searchId: string): void
  updateActiveContext(context: ActiveContext): void
  onMenuNewFile(listener: () => void): RemoveListener
  onMenuOpenFile(listener: () => void): RemoveListener
  onMenuSaveFile(listener: () => void): RemoveListener
  onMenuSaveFileAs(listener: () => void): RemoveListener
  onMenuCloseTab(listener: () => void): RemoveListener
  onSearchResults(listener: (payload: SearchResponsePayload) => void): RemoveListener
  onSearchNavigate(listener: (payload: { tabId: string; line: number; column?: number }) => void): RemoveListener
  onSearchContext(listener: (payload: ActiveContext) => void): RemoveListener
}

type ExtendedElectronAPI = ElectronAPI & {
  path: {
    basename: (path: string, ext?: string) => string
  }
}

declare global {
  interface Window {
    electron: ExtendedElectronAPI
    api: LogEditorApi
  }
}
