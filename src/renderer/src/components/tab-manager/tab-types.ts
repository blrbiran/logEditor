import type { FileLoadedRange, SearchRequest, SearchResultItem } from '@renderer/env'

export const WELCOME_TAB_ID = 'welcome-tab'

export type WindowSessionState = {
  content: string
  loadedRange: FileLoadedRange
  lineWindowStart: number
  loadedLineCount: number
  isLoadingMore: boolean
  isDirty: boolean
  isReadOnly: boolean
  hasWindowEdits: boolean
}

export type FileTab = {
  kind: 'file'
  id: string
  title: string
  filePath?: string
  content: string
  size: number
  loadedRange: FileLoadedRange
  chunkSize: number
  isTruncated: boolean
  isReadOnly: boolean
  isLoadingMore: boolean
  isDirty: boolean
  isActive: boolean
  lineCount: number
  loadedLineCount: number
  lineWindowStart: number
  isWindowed: boolean
  windowOverlap: number
  hasWindowEdits: boolean
  windowSessions?: Record<string, WindowSessionState>
}

export type SearchTab = {
  kind: 'search'
  id: string
  title: string
  request: SearchRequest
  parentSearchId?: string
  results: SearchResultItem[]
  totalMatches: number
  isActive: boolean
}

export type WelcomeTab = {
  kind: 'welcome'
  id: string
  title: string
  isActive: boolean
}

export type Tab = FileTab | SearchTab | WelcomeTab

export const isFileTab = (tab: Tab): tab is FileTab => tab.kind === 'file'
export const isSearchTab = (tab: Tab): tab is SearchTab => tab.kind === 'search'
export const isWelcomeTab = (tab: Tab): tab is WelcomeTab => tab.kind === 'welcome'
