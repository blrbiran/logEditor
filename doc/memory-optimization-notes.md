# Memory Optimization Notes

These notes document how LogEditor reduces the runaway memory usage observed before the sliding-window rewrite that landed between commits `4140507` and `6dd95a6`. Use this file alongside `doc/large-file-windowing.md`, which records the full technical contract for range reads, scroll syncing, and window edits.

---

## Observed Footprint (Pre-Windowing)

- `doc/main_memory_sample.txt` shows the Electron **main process** peaking at ≈ 2.5 GB after repeatedly pressing “Load next chunk” on a ~41 MB log. V8 spend most of its time in heap-profiler routines because every append duplicated the existing buffer.
- `doc/render_memory_sample.txt` captures the **renderer helper** ballooning to ≈ 4.9 GB. The `<textarea>` state held the entire file plus reconciliation copies, and IPC transfers duplicated the chunk again on the Node side.
- In that build, large files were read-only: the only way to reach a later section was to keep appending, meaning memory grew linearly with every click.

---

## Root Causes (Legacy Build)

1. **Monolithic textarea state** – React held a single 40 MB string, so each render temporarily doubled (or tripled) the footprint.
2. **Duplicate IPC buffers** – The main process re-read every previous slice in order to retransmit it, doubling Node memory pressure.
3. **Read-only UX** – Users had to keep loading more chunks to inspect or edit deeper sections, which guaranteed (1) and (2) would keep growing.

---

## Sliding-Window Architecture (Current Build)

### Windowed Tabs & Range Streaming

- Files larger than `LARGE_FILE_THRESHOLD_BYTES = 2 MiB` open as *windowed* tabs. The renderer only keeps a single chunk (`DEFAULT_CHUNK_SIZE = 512 KiB`) plus a `WINDOW_OVERLAP_BYTES = 64 KiB` buffer in memory.
- `window.api.readFileRange()` delegates to `src/main/ipc.ts`, which streams bytes directly from disk, tracks `startLine`/`lineCount`, and caches offset→line mappings (`lineCache`) so subsequent reads avoid recomputing line numbers.
- The renderer mirrors these metrics in `FileTab.loadedRange`, `lineWindowStart`, and `loadedLineCount`. Scroll position feeds into `pendingScrollRatioRef` so the custom scrollbar (`WindowedScrollBar`) always reflects the current portion of the file.

### Scroll & Navigation Flow

- `WindowedScrollBar` exposes two behaviors:
  - **Windowed tabs** – the thumb denotes the currently buffered portion; dragging triggers `jumpToFilePosition`, which requests a centered range and snaps the textarea after the chunk loads.
  - **Fully loaded tabs** – the thumb mirrors the native textarea scroll metrics to keep the UX consistent.
- Auto-loading: when the caret approaches the top/bottom 5 % of a window, `loadMoreContent` fetches the previous/next chunk. This keeps the renderer footprint flat because the previous chunk is discarded once the new data arrives.
- `ensureLineVisible` loops (max 200 iterations) and pages forward/backward until a requested line lives inside the current window. Search navigation therefore never requires loading the entire file.

### Editing Pipeline

- Windowed tabs are fully editable as long as `filePath` exists. `window.api.applyWindowEdit()` writes a temp file that stitches `0..rangeStart`, the edited chunk, and `rangeEnd..EOF` together, then atomically replaces the original.
- Saves are blocked while `hasWindowEdits` is true to prevent losing pending changes. `Cmd+S` applies the patch in place; `Cmd+Shift+S` copies the source first (`Save As…`) and then applies the same window patch to avoid mutating the original file.
- After a successful save, the renderer refreshes `loadedRange` and syncs a trimmed tab snapshot back to the main process (`syncTabState`) so the search service sees the latest content without forcing another large IPC payload.

### Search & Memory Caps

- `searchService.performSearch()` streams from disk (`findMatchesInFile`) whenever the tab is windowed or truncated, enforcing `MAX_STREAM_MATCHES = 5000` to cap memory usage.
- Nested searches reuse cached previews (`filterSearchResults`) instead of re-reading the underlying file. Combined with `dedupeLines`, this guarantees the renderer only highlights the lines already in memory.

For the full set of constants and algorithms, see `doc/large-file-windowing.md`.

---

## Validation Checklist (Current Build)

1. **Open a 40 MB+ log** via drag-and-drop or the file dialog.
   - Expect the tab to enter windowed mode immediately (no read-only banner). Activity Monitor should show a flat memory profile because the renderer holds only one chunk.
2. **Scroll to the bottom, then the top.**
   - Observe the `WindowedScrollBar` thumb jump segments as new chunks stream in. Memory stays roughly constant because previous window content is discarded.
3. **Drag the scrollbar thumb to the middle.**
   - The textarea should jump to the requested portion after a brief load, proving `jumpToFilePosition` is honoring the ratio math.
4. **Edit a line and press `Cmd+S`.**
   - Saving should succeed without loading additional data, and `hasWindowEdits` clears once the patch is written. Use `Cmd+Shift+S` to confirm the same behavior when duplicating the file.
5. **Run a workspace search, double-click a result near the end of the file.**
   - The target line should become visible after `ensureLineVisible` pages the window; the highlight overlay fades after ~2 s.

Following these steps reproduces the Activity Monitor samples with dramatically lower memory: both the main process and renderer remain near their initial baseline because the UI now keeps at most one window (plus overlap) resident in RAM.
