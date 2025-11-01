export const generateTabId = (): string => {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }
  return `tab-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
}

export const buildDefaultFilename = (title: string): string => {
  const sanitized = title.replace(/\s+/g, '_').toLowerCase()
  return sanitized.endsWith('.log') || sanitized.endsWith('.txt')
    ? sanitized
    : `${sanitized || 'untitled'}.log`
}

export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

export const truncate = (value: string, maxLength = 32): string =>
  value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
