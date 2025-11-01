import type { SearchRequest, SearchResultItem } from '@renderer/env'

export const WELCOME_TAB_ID = 'welcome-tab'

export type FileTab = {
  kind: 'file'
  id: string
  title: string
  filePath?: string
  content: string
  isDirty: boolean
  isActive: boolean
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
