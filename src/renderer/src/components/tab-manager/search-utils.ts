import type { SearchMatch, SearchRequest } from '@renderer/env'
import { clamp, truncate } from './helpers'
import { MAX_SNIPPET_LENGTH } from './constants'

export type HighlightSegment = {
  text: string
  isMatch: boolean
}

export type GroupedMatches = {
  line: number
  preview: string
  matches: SearchMatch[]
}

const sortMatchesByColumn = (matches: SearchMatch[]): SearchMatch[] =>
  [...matches].sort((a, b) => a.column - b.column)

export const describeScope = (request: SearchRequest): string =>
  request.scope?.kind === 'search' ? 'Refine' : 'Search'

export const formatExcludeQuery = (request: SearchRequest): string | null => {
  if (!request.excludeQuery?.trim().length) {
    return null
  }
  const trimmed = request.excludeQuery.trim()
  return request.isRegex ? `/${truncate(trimmed)}/` : `"${truncate(trimmed)}"`
}

export const formatSearchQuery = (request: SearchRequest): string => {
  const trimmed = request.query.trim()
  if (!trimmed.length) {
    return '(empty)'
  }
  return request.isRegex ? `/${truncate(trimmed)}/` : `"${truncate(trimmed)}"`
}

export const buildSearchTabTitle = (request: SearchRequest, totalMatches: number): string => {
  const baseTitle = `${describeScope(request)}: ${formatSearchQuery(request)}`
  const excludePart = formatExcludeQuery(request)
  const decoratedTitle = excludePart ? `${baseTitle} – not ${excludePart}` : baseTitle
  return totalMatches ? `${decoratedTitle} (${totalMatches})` : decoratedTitle
}

export const describeScopeDetail = (request: SearchRequest): string =>
  `${request.scope?.kind === 'search' ? 'Within previous search results' : 'Across open tabs'}${
    request.excludeQuery ? `, excluding ${formatExcludeQuery(request) ?? 'filtered terms'}` : ''
  }`

export const computeSnippet = (
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

export const groupMatchesByLine = (
  matches: SearchMatch[],
  dedupeLines: boolean
): GroupedMatches[] => {
  if (!dedupeLines) {
    return matches.map((match) => ({
      line: match.line,
      preview: match.preview,
      matches: [match]
    }))
  }

  const groups = new Map<string, GroupedMatches>()
  matches.forEach((match) => {
    const key = `${match.line}::${match.preview}`
    const existing = groups.get(key)
    if (existing) {
      existing.matches.push(match)
    } else {
      groups.set(key, {
        line: match.line,
        preview: match.preview,
        matches: [match]
      })
    }
  })

  return Array.from(groups.values()).map((group) => ({
    ...group,
    matches: sortMatchesByColumn(group.matches)
  }))
}

export const buildHighlightSegments = (
  preview: string,
  matches: SearchMatch[]
): HighlightSegment[] => {
  const safePreview = preview ?? ''
  const sortedMatches = sortMatchesByColumn(matches)
  const segments: HighlightSegment[] = []
  let cursor = 0

  sortedMatches.forEach((match) => {
    const startIndex = clamp(match.column - 1, 0, safePreview.length)
    if (startIndex > cursor) {
      segments.push({ text: safePreview.slice(cursor, startIndex), isMatch: false })
    }

    const matchLength = Math.max(match.match.length, 1)
    const endIndex = clamp(startIndex + matchLength, startIndex, safePreview.length)
    const highlightText = safePreview.slice(startIndex, endIndex)

    if (highlightText.length > 0) {
      segments.push({ text: highlightText, isMatch: true })
    } else if (match.match.length > 0) {
      segments.push({ text: match.match, isMatch: true })
    } else {
      segments.push({ text: '', isMatch: true })
    }

    cursor = Math.max(cursor, endIndex)
  })

  if (cursor < safePreview.length) {
    segments.push({ text: safePreview.slice(cursor), isMatch: false })
  }

  if (!segments.length && safePreview.length) {
    return [{ text: safePreview, isMatch: false }]
  }

  return segments
}
