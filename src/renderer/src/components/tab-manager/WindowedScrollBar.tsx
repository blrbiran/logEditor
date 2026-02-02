import type React from 'react'
import { useCallback, useRef } from 'react'
import { clamp, normalizeThumbRange } from './helpers'

type WindowedScrollBarProps = {
  startRatio: number
  endRatio: number
  disabled?: boolean
  onSeek(ratio: number): void
  className?: string
}

const MIN_THUMB_PERCENT = 4
const MIN_THUMB_RATIO = MIN_THUMB_PERCENT / 100

export function WindowedScrollBar({
  startRatio,
  endRatio,
  disabled = false,
  onSeek,
  className
}: WindowedScrollBarProps): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)

  const computeRatio = useCallback((clientY: number): number => {
    const track = trackRef.current
    if (!track) {
      return 0
    }
    const rect = track.getBoundingClientRect()
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
      onSeek(ratio)
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

  const thumbMetrics = normalizeThumbRange(startRatio, endRatio, MIN_THUMB_RATIO)

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(thumbMetrics.start * 100)}
      aria-label="File position"
      tabIndex={-1}
      className={`pointer-events-auto relative flex w-3 cursor-pointer select-none overflow-hidden rounded-full bg-slate-200/70 transition hover:bg-slate-300/90 ${
        disabled ? 'opacity-40' : 'opacity-80'
      } ${className ?? ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      <div
        className="absolute left-1/2 w-2 -translate-x-1/2 rounded-full bg-sky-500 shadow-sm"
        style={{
          top: `${thumbMetrics.start * 100}%`,
          height: `${thumbMetrics.size * 100}%`
        }}
      />
    </div>
  )
}
