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

export const normalizeThumbRange = (
  startRatio: number,
  endRatio: number,
  minThumbRatio: number
): { start: number; end: number; size: number } => {
  const normalizedMin = clamp(Number.isFinite(minThumbRatio) ? minThumbRatio : 0, 0, 1)
  const safeStart = clamp(Number.isFinite(startRatio) ? startRatio : 0, 0, 1)
  const safeEnd = clamp(Number.isFinite(endRatio) ? endRatio : safeStart, safeStart, 1)
  let renderStart = safeStart
  let renderEnd = safeEnd
  let renderSize = Math.max(renderEnd - renderStart, 0)

  if (normalizedMin > 0 && renderSize < normalizedMin) {
    const deficit = normalizedMin - renderSize
    let adjustedStart = renderStart - deficit / 2
    let adjustedEnd = renderEnd + deficit / 2

    if (adjustedStart < 0) {
      adjustedEnd = Math.min(1, adjustedEnd - adjustedStart)
      adjustedStart = 0
    }
    if (adjustedEnd > 1) {
      const overshoot = adjustedEnd - 1
      adjustedStart = Math.max(0, adjustedStart - overshoot)
      adjustedEnd = 1
    }

    renderStart = clamp(adjustedStart, 0, Math.max(0, 1 - normalizedMin))
    renderEnd = clamp(adjustedEnd, normalizedMin, 1)
    renderSize = Math.max(renderEnd - renderStart, normalizedMin)
  }

  return { start: renderStart, end: renderEnd, size: renderSize }
}
