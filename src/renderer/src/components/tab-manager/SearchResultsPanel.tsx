import { forwardRef } from 'react'
import type { SearchMatch, SearchResultItem } from '@renderer/env'
import type { SearchTab } from './tab-types'
import {
  buildHighlightSegments,
  computeSnippet,
  describeScopeDetail,
  formatExcludeQuery,
  formatSearchQuery,
  groupMatchesByLine
} from './search-utils'

export type SearchResultsPanelProps = {
  tab: SearchTab
  onSelectMatch: (result: SearchResultItem, match: SearchMatch) => void
}

export const SearchResultsPanel = forwardRef<HTMLDivElement, SearchResultsPanelProps>(
  ({ tab, onSelectMatch }, ref) => {
    const summary = tab.totalMatches
      ? `${tab.totalMatches} match${tab.totalMatches === 1 ? '' : 'es'} across ${tab.results.length} file${
          tab.results.length === 1 ? '' : 's'
        }`
      : 'No matches yet — try adjusting your query.'

    const dedupeLines = tab.request.dedupeLines ?? true

    return (
      <div className="flex h-full flex-col bg-slate-50">
        <div className="border-b border-slate-200 bg-white/70 px-6 py-4">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-500">
            {tab.request.scope?.kind === 'search' ? 'Nested search' : 'Search results'}
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-800">
            {formatSearchQuery(tab.request)}
          </h2>
          <p className="mt-1 text-xs text-slate-400">{describeScopeDetail(tab.request)}</p>
          {tab.request.excludeQuery ? (
            <p className="mt-1 text-xs font-medium text-rose-500">
              Skipping lines containing {formatExcludeQuery(tab.request) ?? 'filtered terms'}
            </p>
          ) : null}
          <p className="mt-2 text-sm text-slate-500">{summary}</p>
        </div>
        <div ref={ref} className="flex-1 overflow-y-auto px-6 py-5">
          {tab.results.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-8 py-10 text-center shadow-sm">
                <p className="text-sm font-semibold text-slate-600">No matches were found.</p>
                <p className="mt-2 text-xs text-slate-400">Try another keyword or enable regex.</p>
              </div>
            </div>
          ) : (
            tab.results.map((result) => (
              <div
                key={result.tabId}
                className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-sky-300 hover:shadow-md"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-slate-100 pb-4">
                  <p className="max-w-[260px] truncate text-sm font-semibold text-slate-800">
                    {result.title}
                  </p>
                  <span className="rounded-full bg-sky-50 px-3 py-1 text-xs font-medium text-sky-600">
                    {result.matches.length} match{result.matches.length === 1 ? '' : 'es'}
                  </span>
                </div>
                <div className="mt-2 text-xs">
                  {groupMatchesByLine(result.matches, dedupeLines).map((group, index) => {
                    const primaryMatch = group.matches[0]
                    if (!primaryMatch) {
                      return null
                    }
                    const key = `${result.tabId}-${group.line}-${index}`
                    const snippet = dedupeLines ? null : computeSnippet(primaryMatch)
                    const segments = dedupeLines ? buildHighlightSegments(group.preview, group.matches) : null

                    return (
                      <div
                        key={key}
                        className="border border-transparent bg-transparent font-mono text-xs leading-5 text-slate-700 transition hover:bg-sky-50"
                        role="button"
                        tabIndex={0}
                        onDoubleClick={() => onSelectMatch(result, primaryMatch)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            onSelectMatch(result, primaryMatch)
                          }
                        }}
                      >
                        <span className="mr-2 font-semibold text-sky-500">{group.line}:</span>
                        {dedupeLines && segments
                          ? segments.map((segment, segmentIndex) => (
                              <span
                                // eslint-disable-next-line react/no-array-index-key
                                key={`${key}-segment-${segmentIndex}`}
                                className={
                                  segment.isMatch
                                    ? 'rounded bg-amber-200 px-1 font-semibold text-slate-900'
                                    : 'text-slate-400'
                                }
                              >
                                {segment.text}
                              </span>
                            ))
                          : (
                            <>
                              <span className="text-slate-400">{snippet?.before}</span>
                              <span className="rounded bg-amber-200 px-1 font-semibold text-slate-900">
                                {snippet?.highlight || '(empty match)'}
                              </span>
                              <span className="text-slate-400">{snippet?.after}</span>
                            </>
                            )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    )
  }
)

SearchResultsPanel.displayName = 'SearchResultsPanel'
