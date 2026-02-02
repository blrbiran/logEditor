import type React from 'react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { clamp, normalizeThumbRange } from './helpers'

type MinimapProps = {
  content: string
  startRatio: number
  endRatio: number
  disabled?: boolean
  onSeek(ratio: number): void
  className?: string
}

const MAX_PREVIEW_LINES = 600
const MAX_CHARS_PER_LINE = 96
const MIN_VIEWPORT_PERCENT = 4
const MIN_VIEWPORT_RATIO = MIN_VIEWPORT_PERCENT / 100
const MIN_ROW_HEIGHT_PX = 2
const MIN_FONT_SIZE_PX = 3

const samplePreviewLines = (content: string): string[] => {
  if (!content) {
    return ['']
  }
  const lines = content.split(/\r?\n/)
  if (!lines.length) {
    return ['']
  }
  if (lines.length <= MAX_PREVIEW_LINES) {
    return lines.map((line) => line.slice(0, MAX_CHARS_PER_LINE))
  }
  const sampleCount = MAX_PREVIEW_LINES
  const lastIndex = lines.length - 1
  const step = sampleCount > 1 ? lastIndex / (sampleCount - 1) : 0
  const samples: string[] = []
  for (let index = 0; index < sampleCount; index += 1) {
    const rawIndex = Math.min(lastIndex, Math.round(index * step))
    const line = lines[rawIndex] ?? ''
    samples.push(line.slice(0, MAX_CHARS_PER_LINE))
  }
  return samples
}

export function Minimap({
  content,
  startRatio,
  endRatio,
  disabled = false,
  onSeek,
  className
}: MinimapProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const draggingRef = useRef(false)

  const previewLines = useMemo(() => samplePreviewLines(content), [content])

  const drawPreview = useCallback(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) {
      return
    }
    const width = container.clientWidth || 1
    const height = container.clientHeight || 1
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    const context = canvas.getContext('2d')
    if (!context) {
      return
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, width, height)
    context.fillStyle = '#f8fafc'
    context.fillRect(0, 0, width, height)
    context.fillStyle = 'rgba(148, 163, 184, 0.6)'
    context.fillRect(width - 1, 0, 1, height)

    const lineCount = previewLines.length
    if (!lineCount) {
      return
    }
    const rowHeight = Math.max(MIN_ROW_HEIGHT_PX, height / lineCount)
    const fontSize = Math.max(MIN_FONT_SIZE_PX, rowHeight * 0.9)
    context.font = `${fontSize}px "JetBrains Mono", "SFMono-Regular", ui-monospace, monospace`
    context.textBaseline = 'top'
    context.fillStyle = 'rgba(30, 41, 59, 0.85)'

    const maxTextWidth = Math.max(8, width - 4)

    for (let index = 0; index < lineCount; index += 1) {
      const text = previewLines[index]
      if (!text) {
        continue
      }
      let snippet = text
      if (context.measureText(snippet).width > maxTextWidth) {
        let low = 0
        let high = snippet.length
        while (low < high) {
          const mid = Math.ceil((low + high) / 2)
          const candidate = `${snippet.slice(0, mid)}…`
          if (context.measureText(candidate).width > maxTextWidth) {
            high = mid - 1
          } else {
            low = mid
          }
        }
        snippet = `${snippet.slice(0, Math.max(0, low))}…`
      }
      const y = index * rowHeight
      context.fillText(snippet, 0, y)
    }
  }, [previewLines])

  useEffect(() => {
    drawPreview()
  }, [drawPreview])

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const container = containerRef.current
    if (!container) {
      return
    }
    const observer = new ResizeObserver(() => {
      drawPreview()
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [drawPreview])

  const computeRatio = useCallback((clientY: number): number => {
    const container = containerRef.current
    if (!container) {
      return 0
    }
    const rect = container.getBoundingClientRect()
    if (rect.height <= 0) {
      return 0
    }
    return clamp((clientY - rect.top) / rect.height, 0, 1)
  }, [])

  const commitSeek = useCallback(
    (ratio: number) => {
      if (disabled) {
        return
      }
      onSeek(clamp(ratio, 0, 1))
    },
    [disabled, onSeek]
  )

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) {
        return
      }
      draggingRef.current = true
      event.currentTarget.setPointerCapture(event.pointerId)
      commitSeek(computeRatio(event.clientY))
    },
    [commitSeek, computeRatio, disabled]
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current || disabled) {
        return
      }
      commitSeek(computeRatio(event.clientY))
    },
    [commitSeek, computeRatio, disabled]
  )

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) {
      return
    }
    draggingRef.current = false
    event.currentTarget.releasePointerCapture(event.pointerId)
  }, [])

  const thumbMetrics = normalizeThumbRange(startRatio, endRatio, MIN_VIEWPORT_RATIO)

  return (
    <div
      ref={containerRef}
      role="slider"
      aria-label="Minimap"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(thumbMetrics.start * 100)}
      tabIndex={-1}
      className={`relative overflow-hidden rounded-md border border-slate-200/80 bg-white/70 shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
        disabled ? 'opacity-50' : 'opacity-100'
      } ${className ?? ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      <canvas ref={canvasRef} className="h-full w-full" />
      <div
        className="pointer-events-none absolute left-0 right-0 rounded-sm border border-sky-400/60 bg-sky-200/35"
        style={{
          top: `${thumbMetrics.start * 100}%`,
          height: `${thumbMetrics.size * 100}%`
        }}
      />
    </div>
  )
}
