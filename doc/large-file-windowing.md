# Large File Windowing

This note captures the sliding-window pipeline introduced across commits `4140507`, `4795add`, `5df5bef`,
`16e4619`, and `cdde0ed`. The feature keeps memory flat while opening multi-gigabyte logs, lets users edit
the currently loaded window, and exposes deterministic IPC contracts so other agents can re-implement the
workflow without reverse-engineering the source.

---

## Core Thresholds & Constants

- `LARGE_FILE_THRESHOLD_BYTES = 2 * 1024 * 1024` – files above 2 MiB enter windowed mode.
- `DEFAULT_CHUNK_SIZE = 512 * 1024` – first chunk length as well as the default range size for follow-up reads.
- `WINDOW_OVERLAP_BYTES = 64 * 1024` – overlap between windows to avoid losing partial lines when paging.
- `MAX_RENDERED_LINE_NUMBERS = 400` – renderer only paints this many gutter labels per frame.
- `MAX_STREAM_MATCHES = 5000` – search results streamed from disk are capped to prevent runaway memory usage.

These values stay in sync between `src/main/ipc.ts` and `src/renderer/src/components/tab-manager/useTabsController.ts`.

---

## Read Pipeline (`open-file-dialog`, `read-files-from-paths`, `read-file-range`)

1. **Initial descriptors (`readFileHead`)**
   - Main process reads the first `DEFAULT_CHUNK_SIZE` bytes of every selected file.
   - The resulting `OpenedFile` objects carry `size`, `loadedBytes`, `chunkSize`, `isTruncated`, `lineCount`,
     and `loadedLineCount`. Line counts are computed eagerly (or lazily via `countLinesInFile` when truncated).
   - Tabs opened from drag-and-drop blobs mirror this shape in the renderer.

2. **Windowed state**
   - Tabs with `isTruncated === true` and a valid `filePath` flip into `isWindowed` mode. Each `FileTab` tracks:
     - `loadedRange: { start, end }` in bytes.
     - `lineWindowStart` so gutter numbers render global lines.
     - `windowOverlap` (<= 64 KB) to soften boundaries when fetching the next chunk.
   - Tabs opened from blobs without a `filePath` stay read-only and cannot request ranges.

3. **`read-file-range` IPC**
   - Renderer calls `window.api.readFileRange({ filePath, start, length })`.
   - Main process opens the file handle once, seeks to `start`, and reads at most `length` bytes.
   - Line metrics are derived via `getLineBreakStats`, and `startLine` is resolved using the shared `lineCache`
     so offsets remain stable between consecutive reads.
   - Result payload:
     ```ts
     {
       filePath,
       start,
       end,
       content,
       totalSize,
       hasMore: end < totalSize,
       startLine,
       lineCount
     }
     ```

---

## Window Navigation Algorithms

### Incremental Paging (`loadMoreContent`)

- **Non-windowed truncated tabs**: additional ranges are appended to `tab.content` until `hasMore === false`.
- **Windowed tabs**: renderer replaces `tab.content` with the incoming slice and updates `lineWindowStart`. Paging in
  either direction respects `windowOverlap` so lines do not split.
- Paging is disabled while `tab.isDirty === true` to avoid losing unsaved edits. Auto-scroll intent is remembered via
  `autoScrollIntentRef` and re-applied after the new content lands.

### Absolute Seek (`jumpToFilePosition`)

- The `WindowedScrollBar` emits a ratio between `0` and `1`.
- Renderer calculates `anchor = Math.round(tab.size * ratio)` and requests a centered range.
- After the range arrives, `pendingScrollRatioRef` snaps the textarea scroll position so the viewport matches
  the thumb location.

### Ensuring Visibility (`ensureLineVisible`)

- When a search result targets a line outside the current window, `ensureLineVisible` loops (max 200 iterations) and
  keeps paging forward/backward until the desired line enters the loaded range. This is what allows search results to
  focus deeply into large files without preloading the entire document.

---

## Editing & Saving Windows

`apply-window-edit` patches only the bytes currently loaded:

1. Main process streams `0..rangeStart` into a temp file, writes the replacement buffer, then streams `rangeEnd..EOF`.
2. Temp file replaces the original via `fs.rename`, guaranteeing atomicity on POSIX file systems.
3. Renderer receives the new file size and updates `loadedRange.end` to `rangeStart + replacementLength`.

Synchronous constraints:

- Window shifts are blocked while `hasWindowEdits` is true.
- `Cmd+S` calls `applyWindowEdit` in place; `Cmd+Shift+S` copies the source (`sourcePath`) first, then applies the same patch.
- Tabs opened without a backing `filePath` stay read-only, but users can `Save As…` to materialize them and exit read-only mode.

See `doc/memory-optimization-notes.md` for the motivation and empirical memory measurements.

---

## Search Integration

- `searchService.performSearch` inspects the cached `SearchableTab`.
- If `tab.isTruncated && tab.filePath`, it calls `findMatchesInFile`, which streams the file with a 512 KB high-water mark,
  respects `excludeQuery`, and stops after `MAX_STREAM_MATCHES`.
- Nested searches reuse cached matches via `filterSearchResults`, ensuring result-within-result queries do not re-read disk.

---

## UI Contract

- `TabManager` paints:
  - A banner describing loaded bytes and the `Load next chunk`/`Fully loaded` prompts (only for non-windowed truncated tabs; windowed tabs hide it).
  - Dynamic gutter numbers by calculating the visible window (never more than 400 entries).
  - A VS Code-style preview (`Minimap`) next to the custom scrollbar. It samples up to 600 lines from the currently loaded window, draws the actual characters (96 chars per line max, auto-ellipsized) onto a `<canvas>`, and forwards pointer drags/clicks to the same `onSeek` handler used by the scrollbar so window jumps stay in sync even when the renderer only hosts a sliding window.
  - `WindowedScrollBar`:
    - **Windowed tabs** – thumb shows the file portion currently buffered; dragging triggers `jumpToFilePosition`.
    - **Fully loaded tabs** – thumb mirrors the native textarea scroll metrics (`standardScrollMetricsRef`).
    - Both the preview and the scrollbar share a `normalizeThumbRange` helper that enforces a 4 % minimum thumb size to eliminate the bounce that previously occurred when dragging near the edges of very large files.
- High-visibility highlights (`highlightRefs`) persist while the user is navigating search results and fade after 2 s.

Follow this document whenever implementing new ingestion strategies or extending the renderer so large files continue to
behave predictably and stay within the documented memory budget.
