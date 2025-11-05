import { randomUUID } from 'crypto'
import { createReadStream } from 'fs'
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
  dedupeLines: boolean
}

type SearchServiceDeps = {
  generateId?: () => string
}

export type SearchService = {
  performSearch(request: SearchRequest): Promise<SearchResponsePayload>
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

  const performSearch = async (rawRequest: SearchRequest): Promise<SearchResponsePayload> => {
    const request = normalizeRequest(rawRequest)
    const { matcher, excludeMatcher } = buildMatchers(request)
    const findOptions: FindMatchOptions = {
      query: request.query,
      isRegex: request.isRegex,
      matchCase: request.matchCase,
      matcher,
      excludeQuery: request.excludeQuery,
      excludeMatcher,
      dedupeLines: request.dedupeLines ?? true
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
        let matches: SearchMatch[] = []
        if (tab.isTruncated && tab.filePath) {
          matches = await findMatchesInFile(tab.filePath, findOptions)
        } else {
          matches = findMatches(tab.content, findOptions)
        }
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

    searchResultsStore.set(payload.searchId, {
      searchId: payload.searchId,
      parentSearchId: payload.parentSearchId,
      request: payload.request,
      results: payload.results
    })
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
      tabStore.set(existing.id, {
        ...existing,
        content,
        size: content.length,
        isTruncated: false,
        loadedRange: {
          start: 0,
          end: content.length
        }
      })
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

const LINE_BREAK_REGEX = /\r?\n/
const STREAM_HIGH_WATER_MARK = 512 * 1024
const MAX_STREAM_MATCHES = 5000

const trimCarriageReturn = (value: string): string =>
  value.endsWith('\r') ? value.slice(0, -1) : value

const shouldExcludeLine = (lineText: string, options: FindMatchOptions): boolean => {
  if (!options.excludeQuery) {
    return false
  }

  if (options.isRegex && options.excludeMatcher) {
    const tester = new RegExp(options.excludeMatcher.source, options.excludeMatcher.flags)
    return tester.test(lineText)
  }

  const haystack = options.matchCase ? lineText : lineText.toLowerCase()
  const needle = options.matchCase ? options.excludeQuery : options.excludeQuery?.toLowerCase()
  return typeof needle === 'string' ? haystack.includes(needle) : false
}

const collectMatchesFromLine = (
  lineText: string,
  lineNumber: number,
  options: FindMatchOptions
): SearchMatch[] => {
  if (!options.query.length) {
    return []
  }

  const matches: SearchMatch[] = []
  if (options.isRegex && options.matcher) {
    const localMatcher = new RegExp(options.matcher.source, options.matcher.flags)
    let execMatch: RegExpExecArray | null
    while ((execMatch = localMatcher.exec(lineText)) !== null) {
      matches.push({
        line: lineNumber,
        column: execMatch.index + 1,
        match: execMatch[0],
        preview: lineText
      })
      if (options.dedupeLines) {
        break
      }
      if (execMatch[0].length === 0) {
        localMatcher.lastIndex += 1
      }
      if (!localMatcher.global) {
        break
      }
    }
    return matches
  }

  const haystack = options.matchCase ? lineText : lineText.toLowerCase()
  const needle = options.matchCase ? options.query : options.query.toLowerCase()
  if (!needle.length) {
    return []
  }

  let fromIndex = 0
  while (fromIndex <= haystack.length) {
    const hit = haystack.indexOf(needle, fromIndex)
    if (hit === -1) {
      break
    }
    matches.push({
      line: lineNumber,
      column: hit + 1,
      match: lineText.slice(hit, hit + needle.length),
      preview: lineText
    })
    if (options.dedupeLines) {
      break
    }
    fromIndex = hit + needle.length
  }

  return matches
}

function findMatches(content: string, options: FindMatchOptions): SearchMatch[] {
  if (!options.query.length) {
    return []
  }

  const lines = content.split(LINE_BREAK_REGEX)
  const matches: SearchMatch[] = []

  lines.forEach((rawLine, index) => {
    const lineText = trimCarriageReturn(rawLine)
    if (shouldExcludeLine(lineText, options)) {
      return
    }
    const lineMatches = collectMatchesFromLine(lineText, index + 1, options)
    if (lineMatches.length) {
      matches.push(...lineMatches)
    }
  })

  return matches
}

const findMatchesInFile = async (
  filePath: string,
  options: FindMatchOptions
): Promise<SearchMatch[]> => {
  if (!options.query.length) {
    return []
  }

  const matches: SearchMatch[] = []
  const stream = createReadStream(filePath, {
    encoding: 'utf-8',
    highWaterMark: STREAM_HIGH_WATER_MARK
  })

  let buffer = ''
  let lineNumber = 0
  let reachedLimit = false

  try {
    for await (const chunk of stream) {
      buffer += chunk
      const segments = buffer.split(LINE_BREAK_REGEX)
      buffer = segments.pop() ?? ''

      for (const rawLine of segments) {
        lineNumber += 1
        const lineText = trimCarriageReturn(rawLine)
        if (shouldExcludeLine(lineText, options)) {
          continue
        }
        const lineMatches = collectMatchesFromLine(lineText, lineNumber, options)
        if (lineMatches.length) {
          matches.push(...lineMatches)
          if (matches.length >= MAX_STREAM_MATCHES) {
            reachedLimit = true
            break
          }
        }
      }

      if (reachedLimit) {
        break
      }
    }
  } finally {
    if (!stream.destroyed) {
      stream.destroy()
    }
  }

  if (!reachedLimit && buffer.length) {
    lineNumber += 1
    const tailLine = trimCarriageReturn(buffer)
    if (!shouldExcludeLine(tailLine, options)) {
      const tailMatches = collectMatchesFromLine(tailLine, lineNumber, options)
      matches.push(...tailMatches)
    }
  }

  if (matches.length > MAX_STREAM_MATCHES) {
    return matches.slice(0, MAX_STREAM_MATCHES)
  }

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
