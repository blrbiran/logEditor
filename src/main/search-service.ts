import { randomUUID } from 'crypto'
import type {
  SearchRequest,
  SearchResponseItem,
  SearchResponsePayload,
  SearchableTab,
  SearchMatch
} from '../common/ipc'

type StoredSearchResultSet = {
  searchId: string
  parentSearchId?: string
  request: SearchRequest
  results: SearchResponseItem[]
}

type FindMatchOptions = {
  query: string
  isRegex: boolean
  matchCase: boolean
  matcher: RegExp | null
  excludeQuery?: string
  excludeMatcher: RegExp | null
}

type SearchServiceDeps = {
  generateId?: () => string
}

export type SearchService = {
  performSearch(request: SearchRequest): SearchResponsePayload
  syncTabState(tab: SearchableTab): void
  removeTabState(tabId: string): void
  disposeSearchResults(searchId: string): void
  updateTabContentByFilePath(filePath: string, content: string): void
  getTabSnapshot(tabId: string): SearchableTab | undefined
}

export const createSearchService = (deps: SearchServiceDeps = {}): SearchService => {
  const tabStore = new Map<string, SearchableTab>()
  const searchResultsStore = new Map<string, StoredSearchResultSet>()
  const generateId = deps.generateId ?? (() => {
    try {
      return randomUUID()
    } catch {
      return `search-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
    }
  })

  const normalizeRequest = (request: SearchRequest): SearchRequest => {
    const trimmedQuery = request.query.trim()
    const trimmedExclude = request.excludeQuery?.trim() ?? ''
    return {
      ...request,
      query: trimmedQuery,
      scope: request.scope ?? { kind: 'workspace' },
      excludeQuery: trimmedExclude.length ? trimmedExclude : undefined,
      dedupeLines: request.dedupeLines ?? true
    }
  }

  const buildMatchers = (request: SearchRequest): {
    matcher: RegExp | null
    excludeMatcher: RegExp | null
  } => {
    let matcher: RegExp | null = null
    if (request.query.length && request.isRegex) {
      matcher = new RegExp(request.query, request.matchCase ? 'g' : 'gi')
    }

    let excludeMatcher: RegExp | null = null
    if (request.excludeQuery && request.isRegex) {
      excludeMatcher = new RegExp(request.excludeQuery, request.matchCase ? 'g' : 'gi')
    }

    return { matcher, excludeMatcher }
  }

  const performSearch = (rawRequest: SearchRequest): SearchResponsePayload => {
    const request = normalizeRequest(rawRequest)
    const { matcher, excludeMatcher } = buildMatchers(request)
    const findOptions: FindMatchOptions = {
      query: request.query,
      isRegex: request.isRegex,
      matchCase: request.matchCase,
      matcher,
      excludeQuery: request.excludeQuery,
      excludeMatcher
    }

    let results: SearchResponseItem[] = []
    if (!request.query.length) {
      results = []
    } else if (request.scope?.kind === 'search') {
      const base = searchResultsStore.get(request.scope.searchId)
      if (base) {
        results = filterSearchResults(base.results, findOptions)
      }
    } else {
      for (const tab of tabStore.values()) {
        const matches = findMatches(tab.content, findOptions)
        if (matches.length) {
          results.push({
            tabId: tab.id,
            title: tab.title,
            filePath: tab.filePath,
            matches
          })
        }
      }
    }

    const payload: SearchResponsePayload = {
      searchId: generateId(),
      parentSearchId: request.scope?.kind === 'search' ? request.scope.searchId : undefined,
      request,
      results
    }

    searchResultsStore.set(payload.searchId, payload)
    return payload
  }

  const syncTabState = (tab: SearchableTab): void => {
    tabStore.set(tab.id, tab)
  }

  const removeTabState = (tabId: string): void => {
    tabStore.delete(tabId)
  }

  const disposeSearchResults = (searchId: string): void => {
    searchResultsStore.delete(searchId)
  }

  const updateTabContentByFilePath = (filePath: string, content: string): void => {
    if (!filePath) {
      return
    }
    const existing = Array.from(tabStore.values()).find((tab) => tab.filePath === filePath)
    if (existing) {
      tabStore.set(existing.id, { ...existing, content })
    }
  }

  const getTabSnapshot = (tabId: string): SearchableTab | undefined => tabStore.get(tabId)

  return {
    performSearch,
    syncTabState,
    removeTabState,
    disposeSearchResults,
    updateTabContentByFilePath,
    getTabSnapshot
  }
}

function findMatches(content: string, options: FindMatchOptions): SearchMatch[] {
  const lines = content.split(/\r?\n/)
  const matches: SearchMatch[] = []
  const excludeNeedle =
    options.excludeQuery && !options.isRegex
      ? options.matchCase
        ? options.excludeQuery
        : options.excludeQuery.toLowerCase()
      : undefined

  const shouldExcludeLine = (lineText: string): boolean => {
    if (!options.excludeQuery) {
      return false
    }
    if (options.isRegex && options.excludeMatcher) {
      const tester = new RegExp(options.excludeMatcher.source, options.excludeMatcher.flags)
      return tester.test(lineText)
    }
    const haystack = options.matchCase ? lineText : lineText.toLowerCase()
    return excludeNeedle ? haystack.includes(excludeNeedle) : false
  }

  lines.forEach((lineText, index) => {
    if (!lineText.length && !options.query.length) {
      return
    }

    if (shouldExcludeLine(lineText)) {
      return
    }

    if (options.isRegex && options.matcher) {
      const localMatcher = new RegExp(options.matcher.source, options.matcher.flags)
      let execMatch: RegExpExecArray | null
      while ((execMatch = localMatcher.exec(lineText)) !== null) {
        matches.push({
          line: index + 1,
          column: execMatch.index + 1,
          match: execMatch[0],
          preview: lineText
        })
        if (execMatch[0].length === 0) {
          localMatcher.lastIndex += 1
        }
        if (!localMatcher.global) break
      }
    } else {
      const haystack = options.matchCase ? lineText : lineText.toLowerCase()
      const needle = options.matchCase ? options.query : options.query.toLowerCase()
      let fromIndex = 0
      while (fromIndex <= haystack.length) {
        const hit = haystack.indexOf(needle, fromIndex)
        if (hit === -1) break
        matches.push({
          line: index + 1,
          column: hit + 1,
          match: lineText.slice(hit, hit + options.query.length),
          preview: lineText
        })
        fromIndex = hit + (needle.length || 1)
      }
    }
  })

  return matches
}

function filterSearchResults(
  baseResults: SearchResponseItem[],
  options: FindMatchOptions
): SearchResponseItem[] {
  if (!options.query.length) {
    return []
  }

  const result: SearchResponseItem[] = []

  baseResults.forEach((item) => {
    const aggregatedMatches: SearchMatch[] = []
    const processedLines = new Set<string>()

    item.matches.forEach((match) => {
      const key = `${match.line}::${match.preview}`
      if (processedLines.has(key)) {
        return
      }
      processedLines.add(key)

      const nestedMatches = findMatches(match.preview, options)
      nestedMatches.forEach((nested) => {
        aggregatedMatches.push({
          line: match.line,
          column: nested.column,
          match: nested.match,
          preview: match.preview
        })
      })
    })

    if (aggregatedMatches.length > 0) {
      result.push({
        tabId: item.tabId,
        title: item.title,
        filePath: item.filePath,
        matches: aggregatedMatches
      })
    }
  })

  return result
}
