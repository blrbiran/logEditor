import './search.css'
import type { SearchRequest, SearchResultItem } from './env'

const form = document.getElementById('search-form') as HTMLFormElement | null
const queryInput = document.getElementById('query') as HTMLInputElement | null
const regexInput = document.getElementById('regex') as HTMLInputElement | null
const matchCaseInput = document.getElementById('match-case') as HTMLInputElement | null
const statusElement = document.getElementById('status') as HTMLParagraphElement | null

type StatusState = 'idle' | 'pending' | 'success' | 'error'

const setStatus = (message: string, state: StatusState = 'idle'): void => {
  if (!statusElement) return
  statusElement.textContent = message
  statusElement.dataset.state = state
}

const handleSearch = async (): Promise<void> => {
  if (!queryInput || !regexInput || !matchCaseInput) {
    return
  }

  const query = queryInput.value.trim()
  if (!query) {
    setStatus('Please enter text to search.', 'error')
    return
  }

  const request: SearchRequest = {
    query,
    isRegex: regexInput.checked,
    matchCase: matchCaseInput.checked
  }

  try {
    setStatus('Searching…', 'pending')
    const results = (await window.api.performSearch(request)) as SearchResultItem[]
    window.api.emitSearchResults(results)
    const totalMatches = results.reduce((acc, item) => acc + item.matches.length, 0)
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
  })
}
