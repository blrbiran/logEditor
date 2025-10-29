import './search.css'
import type { SearchRequest, SearchResultItem } from './env'

const form = document.getElementById('search-form') as HTMLFormElement | null
const queryInput = document.getElementById('query') as HTMLInputElement | null
const regexInput = document.getElementById('regex') as HTMLInputElement | null
const matchCaseInput = document.getElementById('match-case') as HTMLInputElement | null
const statusElement = document.getElementById('status') as HTMLParagraphElement | null

const setStatus = (message: string, isError = false): void => {
  if (!statusElement) return
  statusElement.textContent = message
  statusElement.style.color = isError ? '#f87171' : '#94a3b8'
}

const handleSearch = async (): Promise<void> => {
  if (!queryInput || !regexInput || !matchCaseInput) {
    return
  }

  const query = queryInput.value.trim()
  if (!query) {
    setStatus('Please enter text to search.', true)
    return
  }

  const request: SearchRequest = {
    query,
    isRegex: regexInput.checked,
    matchCase: matchCaseInput.checked
  }

  try {
    setStatus('Searching…')
    const results = (await window.api.performSearch(request)) as SearchResultItem[]
    window.api.emitSearchResults(results)
    const totalMatches = results.reduce((acc, item) => acc + item.matches.length, 0)
    if (totalMatches === 0) {
      setStatus('No matches found.', true)
    } else {
      setStatus(`Sent ${totalMatches} match${totalMatches === 1 ? '' : 'es'} to the main window.`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Search failed.'
    setStatus(`Error: ${message}`, true)
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
