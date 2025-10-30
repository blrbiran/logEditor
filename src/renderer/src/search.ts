import './search.css'
import type { ActiveContext, SearchRequest, SearchResponsePayload } from './env'

const form = document.getElementById('search-form') as HTMLFormElement | null
const queryInput = document.getElementById('query') as HTMLInputElement | null
const excludeInput = document.getElementById('exclude-query') as HTMLInputElement | null
const regexInput = document.getElementById('regex') as HTMLInputElement | null
const matchCaseInput = document.getElementById('match-case') as HTMLInputElement | null
const statusElement = document.getElementById('status') as HTMLParagraphElement | null

type StatusState = 'idle' | 'pending' | 'success' | 'error'

let currentContext: ActiveContext = { kind: 'welcome' }

const setStatus = (message: string, state: StatusState = 'idle'): void => {
  if (!statusElement) return
  statusElement.textContent = message
  statusElement.dataset.state = state
}

const describeContext = (context: ActiveContext): string => {
  if (context.kind === 'search') {
    return 'Nested search mode — refining previous results.'
  }
  return 'Workspace search mode.'
}

const ensureIdleContextStatus = (): void => {
  if (!statusElement) return
  if (statusElement.dataset.state && statusElement.dataset.state !== 'idle') {
    return
  }
  setStatus(describeContext(currentContext), 'idle')
}

const handleSearch = async (): Promise<void> => {
  if (!queryInput || !regexInput || !matchCaseInput) {
    return
  }

  const query = queryInput.value.trim()
  const exclude = excludeInput?.value.trim() ?? ''
  if (!query) {
    setStatus('Please enter text to search.', 'error')
    return
  }

  const request: SearchRequest = {
    query,
    isRegex: regexInput.checked,
    matchCase: matchCaseInput.checked,
    excludeQuery: exclude.length ? exclude : undefined,
    scope:
      currentContext.kind === 'search'
        ? { kind: 'search', searchId: currentContext.searchId }
        : { kind: 'workspace' }
  }

  try {
    setStatus(
      request.scope?.kind === 'search' ? 'Searching within previous results…' : 'Searching…',
      'pending'
    )
    const payload = (await window.api.performSearch(request)) as SearchResponsePayload
    window.api.emitSearchResults(payload)
    const totalMatches = payload.results.reduce((acc, item) => acc + item.matches.length, 0)
    if (totalMatches === 0) {
      setStatus('No matches found.', 'idle')
    } else {
      setStatus(
        `Sent ${totalMatches} match${totalMatches === 1 ? '' : 'es'} to the main window.`,
        'success'
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Search failed.'
    setStatus(`Error: ${message}`, 'error')
  }
}

window.api.onSearchContext((context) => {
  currentContext = context
  ensureIdleContextStatus()
})

if (form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    await handleSearch()
  })
}

if (queryInput) {
  window.requestAnimationFrame(() => {
    queryInput.focus()
    queryInput.select()
    ensureIdleContextStatus()
  })
}
