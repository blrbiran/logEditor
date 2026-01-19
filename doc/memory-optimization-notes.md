# Memory Optimization Notes

## Observed Footprint

- `doc/main_memory_sample.txt` captures the Electron main process peaking at **≈2.5 GB** after loading ~41 MB of data. The call stack shows the main thread busy in V8 heap profiler routines while streaming log data.
- `doc/render_memory_sample.txt` shows the renderer helper ballooning to **≈4.9 GB** for the same workload, with V8 compilation and garbage-collector frames dominating the sample.
- Both traces were recorded while repeatedly pressing “Load next chunk”, which forced the renderer textarea and main-process IPC payloads to materialize tens of megabytes at once.

## Root Causes

1. **Monolithic textarea state** – Every “Load next chunk” appended to a single React state string. The renderer held the cumulative 40 MB file in JS memory, and V8 kept multiple copies alive during reconciliation, which explains the multi‑GB helper footprint.
2. **Duplicate IPC buffers** – The main process re-read prior slices so it could send them back to the renderer, effectively doubling the amount of memory used on the Node side.
3. **Read-only UX** – Large files were marked read-only, forcing users to keep loading further chunks even when only a specific section was needed, exacerbating (1) and (2).

## Sliding-Window Editing (New Behavior)

- Tabs that exceed the large-file threshold now enter *windowed* mode:
  - Renderer keeps only a single chunk (plus overlap) in memory (`tab.content`), so the `<textarea>` never holds the entire file.
  - The gutter shows global line numbers by offsetting with `tab.lineWindowStart`, so scrolling keeps its sense of place.
  - A header banner exposes the active line range, byte counts, and provides *Previous/Next window* buttons; scrolling to the extremes automatically requests the next chunk.
- Window shifts occur in both directions and reuse the new IPC payloads (`startLine`, `lineCount`) to maintain smooth navigation without the “click 60 times” workflow.
- Edits inside a window are persisted via the new `api.applyWindowEdit` call:
  - Users can save in-place (`Cmd+S`), which streams the change into the original file without touching the rest of the document.
  - `Save As…` copies the source file first and then applies the pending window edits so the original stays intact.
  - Window shifts are blocked while unsaved changes exist to avoid data loss; the banner surfaces that requirement.

## Validation Checklist

1. Open a 40 MB+ log file and scroll instead of using “Load next chunk”.
   - **Expect** memory usage to stabilize because the renderer only retains the active window.
2. Scroll near the top or bottom: the banner should update the line range and the textarea should seamlessly swap content.
3. Make an edit within the window, press `Cmd+S`, and confirm the banner clears the warning without loading additional content.
4. Use `Save As…` to duplicate the large file; verify the destination contains your window edits while the original remains unchanged.

Following this flow reproduces the Activity Monitor samples with dramatically lower footprints, because the UI now keeps at most one window (plus small overlap) resident in memory.
