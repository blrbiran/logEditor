import type React from 'react'
import { useCallback, useRef } from 'react'
import { clamp } from './helpers'

type WindowedScrollBarProps = {
  startRatio: number
  endRatio: number
  disabled?: boolean
  offsetTop?: number
  offsetBottom?: number
  onSeek(ratio: number): void
}

const MIN_THUMB_PERCENT = 4

export function WindowedScrollBar({
  startRatio,
  endRatio,
  disabled = false,
  offsetTop = 0,
  offsetBottom = 0,
  onSeek
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

  const safeStart = clamp(Number.isFinite(startRatio) ? startRatio : 0, 0, 1)
  const safeEnd = clamp(Number.isFinite(endRatio) ? endRatio : safeStart, safeStart, 1)
  const rawRange = Math.max((safeEnd - safeStart) * 100, MIN_THUMB_PERCENT)
  const maxRange = Math.max(100 - safeStart * 100, MIN_THUMB_PERCENT)
  const thumbRange = Math.min(rawRange, maxRange)
  const topInset = Number.isFinite(offsetTop) ? -offsetTop : 0
  const bottomInset = Number.isFinite(offsetBottom) ? -offsetBottom : 0

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(safeStart * 100)}
      aria-label="File position"
      tabIndex={-1}
      className={`pointer-events-auto absolute right-2 flex w-3 cursor-pointer select-none rounded-full bg-slate-200/70 transition hover:bg-slate-300/90 ${
        disabled ? 'opacity-40' : 'opacity-80'
      }`}
      style={{
        top: `${topInset}px`,
        bottom: `${bottomInset}px`
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      <div
        className="absolute left-1/2 w-2 -translate-x-1/2 rounded-full bg-sky-500 shadow-sm"
        style={{
          top: `${safeStart * 100}%`,
          height: `${thumbRange}%`
        }}
      />
    </div>
  )
}
