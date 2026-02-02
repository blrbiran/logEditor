# LogEditor Requirement

LogEditor 是一款基于 Electron + React + Tailwind CSS + TypeScript + electron-vite 的桌面日志查看与编辑工具，具备多标签、跨标签搜索与大文件滑窗编辑能力。本文档同步到 `main` 分支 commit `3eed02f`，覆盖了提交 `4140507` 至 `3eed02f` 引入的“大文件窗口化 + 自定义滚动条 + 拖拽路径解析增强”系列改动。遵循此文档即可由 LLM 或人工复刻完整项目。

---

## 1. 项目目标与范围

- 面向日志调试与分析，提供多标签文本编辑、跨标签/嵌套搜索、快速行定位与高亮提示。
- 针对 >2 MB 的日志启用滑窗模式：渲染端仅保留单个窗口、支持字节/行精准跳转，并允许在窗口中原地保存。
- 桌面端原生体验：窗口管理遵循平台规范，支持 macOS / Windows / Linux。
- 强调可维护的模块化：主进程负责窗口、文件 I/O、搜索；预加载层暴露受控 API；渲染端处理 UI 状态。
- 文档与代码双向约束：`doc/memory-optimization-notes.md` 与 `doc/large-file-windowing.md` 记录性能与滑窗契约。

---

## 2. 技术栈与版本要求

- Electron `^38.1.2`
- React + React DOM `^19.1.1`
- TypeScript `^5.9.2`（main / preload / renderer 统一）
- electron-vite `^4.0.1`（HMR、双入口构建）
- Tailwind CSS `^4.1.16` + `@tailwindcss/postcss` + `autoprefixer`
- ESLint `^9.36.0` + Prettier `^3.6.2`（继承 `@electron-toolkit` 规则）
- electron-builder `^25.1.8`（打包）
- @electron-toolkit 组件：`utils`（快捷键/环境辅助）、`preload`（Electron API polyfill）
- electron-updater `^6.3.9`（预留自动更新能力，尚未在 main 进程启用）

---

## 3. 运行脚本

- `npm run dev`：electron-vite 开发模式，主窗口/搜索窗口支持 HMR。
- `npm run build`：先运行 `npm run typecheck` 再执行 electron-vite build。
- `npm run start`：`electron-vite preview` 运行构建产物。
- `npm run typecheck[:node|:web]`：针对两个 tsconfig 的类型检查。
- `npm run build:{mac|win|linux}`：构建后交给 electron-builder 生成平台包。
- `npm run build:unpack`：构建并输出未压缩的 Electron 目录，用于调试 installer。
- `npm run format` / `npm run lint`：Prettier + ESLint。

---

## 4. 工程结构

```
src/
├── common/
│   └── ipc.ts                  # 共享类型、IPC 契约
├── main/
│   ├── index.ts                # Electron 生命周期 orchestrator
│   ├── window-manager.ts       # 主/搜索窗口管理
│   ├── menu.ts                 # 菜单模板
│   ├── search-service.ts       # 搜索/缓存/磁盘流查找
│   └── ipc.ts                  # 文件 I/O、IPC handler、滑窗编辑
├── preload/
│   ├── index.ts                # contextBridge + 统一 API
│   └── index.d.ts              # 全局声明
└── renderer/
    ├── index.html              # 主窗口入口
    ├── search.html             # 搜索窗口入口
    └── src/
        ├── main.tsx / App.tsx
        ├── index.css           # Tailwind + 基础样式
        ├── search.ts / search.css
        ├── assets/             # SVG、基础 CSS
        ├── utils/
        │   └── text-metrics.ts # 行数计算工具
        └── components/
            ├── TabManager.tsx
            ├── Versions.tsx
            └── tab-manager/
                ├── useTabsController.ts
                ├── SearchResultsPanel.tsx
                ├── WindowedScrollBar.tsx
                ├── Minimap.tsx
                ├── constants.ts / helpers.ts / search-utils.ts / tab-types.ts
doc/
├── requirement.md
├── memory-optimization-notes.md
└── large-file-windowing.md     # 滑窗实现细节
tests/
├── windowed-line-tester.mjs    # 行号/窗口边界验证脚本
└── generated_*                 # 大文件样例
```

辅助配置：`electron.vite.config.ts`、`tailwind.config.js`、`tsconfig.*`、`electron-builder.yml`、`resources/icon.png`。

---

## 5. 架构概览

1. **共享契约 (`src/common/ipc.ts`)**：集中声明 `SearchRequest`、`SearchResponsePayload`、`OpenedFile`、`FileRangePayload`、`WindowEditPayload`、`ActiveContext` 等，保证 main/preload/renderer 一致。
2. **主进程**：`index.ts` 驱动生命周期，`window-manager` 管理窗口，`menu` 注入菜单行为，`ipc.ts` 实现文件读写/滑窗编辑/保存，`search-service` 负责搜索和结果缓存。
3. **预加载层**：通过 `contextBridge` 暴露 `window.api`，对外提供受控的 `openFileDialog` / `readFileRange` / `applyWindowEdit` 等方法，并封装订阅工具。
4. **渲染进程（React）**：`TabManager` 组合 `useTabsController`、`SearchResultsPanel`、`WindowedScrollBar`，实现多标签、拖拽打开、滑窗滚动、搜索结果跳转等 UI。
5. **搜索窗口**：独立 `search.html + search.ts`，收集查询条件，调用主窗口 API 并通过 IPC 回传结果。
6. **文档约束**：`doc/memory-optimization-notes.md` 和 `doc/large-file-windowing.md` 详细描述滑窗动机、指标与算法，应与代码保持一致。

---

## 6. 主进程需求

### 6.1 入口 orchestrator（`src/main/index.ts`）

- 维护 `activeContext`（welcome/file/search），并在更新时调用 `windowManager.sendSearchContext` 同步到搜索窗口。
- `app.whenReady()` 中：
  - `electronApp.setAppUserModelId('com.electron')`（Windows 要求）。
  - `app.on('browser-window-created', optimizer.watchWindowShortcuts)`。
  - 实例化 `windowManager.createMainWindow()`。
  - `registerIpcHandlers({ windowManager, searchService, setActiveContext })`。
  - `buildApplicationMenu({ sendToRenderer, openSearchWindow })`。
- `app.on('activate')`：macOS 无窗口时重建主窗+菜单。
- `app.on('window-all-closed')`：非 macOS 平台直接退出。

### 6.2 窗口管理器（`src/main/window-manager.ts`）

- 追踪 `mainWindow`/`searchWindow` 并暴露：
  - `createMainWindow()`：900×670，`preload` 指向 `../preload/index.js`，阻止 `window.open`（交给 `shell.openExternal`），dev 环境加载 `process.env.ELECTRON_RENDERER_URL`，生产加载本地 HTML。
  - `openSearchWindow()`：420×528，不可缩放；若已存在则刷新上下文并聚焦。
  - `sendToRenderer(channel, payload)`、`sendSearchContext(context)`、`focusMainWindow()`。
  - `ensureMainWindow()`：在任何 IPC handler 内保证主窗存在。

### 6.3 菜单模块（`src/main/menu.ts`）

- 模板包含 `File / Edit / Search / View / Window (+ App on macOS)`。
- `File` 菜单通过 `sendToRenderer` 分发 `menu:new-file|open-file|save-file|save-file-as|close-tab`。
- `Search › Find…` 调用 `openSearchWindow()`。
- `View` 内根据 `is.dev` 在 `reload` 与 `forceReload` 间切换，保留 `toggleDevTools`。
- `Window` 菜单在 macOS 下包含 `front`、`Zoom` 等额外条目，并统一暴露 `Split Right (CmdOrCtrl+\)`，通过 `sendToRenderer('menu:split-right')` 指示渲染进程按 VS Code 风格拆分当前编辑器。

### 6.4 文件读取与滑窗编辑（`src/main/ipc.ts`）

- 常量：
  - `LARGE_FILE_THRESHOLD_BYTES = 2 MiB`，大于阈值即 `isTruncated`。
  - `DEFAULT_CHUNK_SIZE = 512 KiB`，初始/增量读取大小。
  - `STREAM_HIGH_WATER_MARK = 512 KiB`（搜索流）。
- `readFileHead(filePath)`：
  - 使用 `fs.stat` 获取大小，仅读取首个 chunk。
  - 记录 `content`、`size`、`loadedBytes`、`chunkSize`、`isTruncated`、`lineCount`、`loadedLineCount`。
  - `< 2 MiB` 的文件直接加载完整内容并可编辑。
- `readFiles(filePaths)`：去重后批量调用 `readFileHead`，供 `open-file-dialog` 与 `read-files-from-paths` 返回。
- `readFileRange({ filePath, start, length })`：
  - 对 `start`、`length` 做边界校验。
  - 使用 `fs.open` + `handle.read` 读取窗口内容。
  - `lineCache: Map<filePath, Map<byteOffset,line>>` 用于缓存偏移到行号的映射；每次返回 `startLine`、`lineCount`、`hasMore`。
- `applyWindowEdit({ filePath, rangeStart, rangeEnd, replacement })`：
  - 通过 `copySegment` 把 `0..rangeStart`、`rangeEnd..EOF` 流式写入临时文件，在中间插入 `replacement`。
  - 写完即 `fs.rename` 覆盖原文件，并返回最新 `size`；失败时删除临时文件。
  - 成功后清理 `lineCache`，以便后续 `readFileRange` 可重新计算行号。
- `save-file-dialog`：
  - 若 `payload.filePath` 为空则弹出对话框。
  - `sourcePath` 存在时执行 `fs.copyFile`（滑窗 Save As），否则写入 `content` 并调用 `searchService.updateTabContentByFilePath` 保持搜索缓存最新。
- 其余辅助：`countLinesInFile`（流式统计行数）、`getLineBreakStats`、`getLineNumberForOffset`。

### 6.5 搜索服务（`src/main/search-service.ts`）

- 状态：
  - `tabStore: Map<string, SearchableTab>` —— 存储渲染端同步的标签快照（含 `size`、`loadedRange`、`isTruncated`、`lineCount` 等）。
  - `searchResultsStore: Map<string, StoredSearchResultSet>` —— 缓存父子搜索链。
- `performSearch(request)`：
  - `normalizeRequest` 负责 trims、默认 scope（workspace）、`dedupeLines` 默认为 true、清理 `excludeQuery`。
  - `buildMatchers` 按 `isRegex/matchCase` 生成正则，若 `tab.isTruncated && tab.filePath` 则走 `findMatchesInFile`。
  - `findMatchesInFile` 通过 `createReadStream` 分片扫描，尊重 `excludeQuery`，遇到零长度匹配时手动推进，最多 `MAX_STREAM_MATCHES = 5000`。
  - scope.kind === 'search' 时使用 `filterSearchResults` 在已有结果上再次匹配。
- 其他 API：`syncTabState`、`removeTabState`、`disposeSearchResults`、`updateTabContentByFilePath`、`getTabSnapshot`。

### 6.6 IPC 通道总览

| Channel | 方向 | Payload | 说明 |
| --- | --- | --- | --- |
| `open-file-dialog` | renderer → main (invoke) | - | 弹出多选文件对话框，返回 `OpenedFile[]`（含 `size`、`loadedRange`、`lineCount` 等）。 |
| `read-files-from-paths` | renderer → main (invoke) | `string[]` | 接收拖拽路径，去重后读取首个 chunk。 |
| `read-file-range` | renderer → main (invoke) | `FileRangeRequest` | 滑窗加载：返回 `{ start, end, content, totalSize, hasMore, startLine, lineCount }`。 |
| `apply-window-edit` | renderer → main (invoke) | `WindowEditPayload` | 将当前窗口写回磁盘，返回 `WindowEditResult`（新文件大小）。 |
| `save-file-dialog` | renderer → main (invoke) | `SaveFilePayload` | 保存/另存。若 `sourcePath` 存在则复制原文件后再写入窗口。 |
| `perform-search` | renderer/search → main (invoke) | `SearchRequest` | 执行搜索，返回 `SearchResponsePayload`。 |
| `sync-tab-state` | renderer → main (send) | `SearchableTab` | 同步标签快照，滑窗模式仅同步元数据。 |
| `remove-tab-state` | renderer → main (send) | `tabId` | 标签关闭时清理缓存。 |
| `display-search-results` | search renderer → main | `SearchResponsePayload` | 搜索窗口把结果推送给主窗口。 |
| `navigate-to-file-line` | search renderer → main | `{ tabId, line, column? }` | 搜索窗口请求主窗口跳转。 |
| `open-search-window` | renderer → main | - | 打开/聚焦搜索窗口。 |
| `dispose-search-results` | renderer → main | `searchId` | 搜索标签关闭时释放缓存。 |
| `update-active-context` | renderer → main | `ActiveContext` | 同步当前活动页面。 |
| `focus-main-window` | search renderer → main | - | 搜索窗口在提交前确保主窗在前台。 |
| `menu:*` | main → renderer | - | 主进程菜单事件广播。 |
| `search:results` | main → renderer | `SearchResponsePayload` | 主进程把搜索结果送到主窗口。 |
| `search:navigate` | main → renderer | `{ tabId, line, column? }` | 搜索窗口发起的跳转指令。 |
| `search:context` | main → search renderer | `ActiveContext` | 搜索窗口显示当前 scope。 |

---

## 7. 预加载层（`src/preload/index.ts` + `index.d.ts`）

- `subscribe(channel, listener)` 与 `invoke(channel, payload)` 提供统一封装，简化 React `useEffect` 清理。
- `window.api` 方法：
  - 文件：`openFileDialog`、`readFilesFromPaths`、`readFileRange`、`applyWindowEdit`、`saveFileDialog`。
  - 搜索：`performSearch`、`emitSearchResults`、`emitNavigateToLine`。
  - 状态：`syncTabState`、`removeTabState`、`disposeSearchResults`、`updateActiveContext`、`focusMainWindow`、`openSearchWindow`。
  - 监听：`onMenu*`（当前包括 `new-file/open-file/save-file/save-file-as/close-tab/split-right`）、`onSearchResults`、`onSearchNavigate`、`onSearchContext`。
- 暴露 `window.electron.path.basename`，供渲染端在无 `filePath` 的情况下构造标题。
- 在 context isolation 下额外通过 `window.electron.webUtils.getPathForFile` 代理原生拖拽文件路径，保证 Finder 拖放可获取真实 `filePath` 并与 “Open…” 菜单行为一致。
- 若 `contextIsolation` 关闭，则退回到 `window.electron`/`window.api` 兼容模式。
- `env.d.ts` re-export `src/common/ipc.ts` 中的所有类型，React 组件直接 `import type { ... } from '@renderer/env'`。

---

## 8. 渲染进程（主窗口 React）

### 8.1 标签类型与工具

- `tab-manager/tab-types.ts`：
  - `FileTab` 新增 `size`、`loadedRange`、`chunkSize`、`isTruncated`、`isWindowed`、`windowOverlap`、`lineCount`、`loadedLineCount`、`lineWindowStart`、`hasWindowEdits` 等字段。
  - `SearchTab` 保存 `request`、`results`、`totalMatches`、`parentSearchId`。
- `helpers.ts`：`generateTabId()` 优先 `crypto.randomUUID`，`buildDefaultFilename()` 生成保存对话框默认名称，`clamp()`、`truncate()`。
- `constants.ts`：`LINE_NUMBER_GUTTER_WIDTH = 56`、`MAX_SNIPPET_LENGTH = 160`。
- `utils/text-metrics.ts`：`countLines`、`countLinesForAppend`，配合大型文本增量加载更新行数。

### 8.2 `useTabsController`（`tab-manager/useTabsController.ts`）

- 状态：
  - `tabs`, `activeTabId`, `tabsRef`, `activeTabIdRef`, `activationStackRef`（最近访问顺序）。
  - `pendingSyncMapRef` 避免在 >8 MB 文件上同步全文内容，仅同步元数据（`LARGE_FILE_SYNC_THRESHOLD_BYTES = 8 MiB`）。
- 核心行为：
  - `applyOpenedFiles` 以 `path` 优先、否则以 `name.toLowerCase()` 去重；若 `OpenedFile.isTruncated && filePath`，则打开窗口模式并设置 `windowOverlap = min(64 KiB, chunkSize/2)`。
  - `createNewTab` / `openFiles` / `openFilesFromPaths` / `openFilesFromContent`：支持菜单、拖拽、浏览器 File API 读取 blob（当拖拽源无真实路径时）。
  - `updateTabContent`：非窗口模式直接修改全文；窗口模式标记 `hasWindowEdits` 并在 `lineCount` 上累加差值。
  - `handleSave(forceSaveAs)`：窗口模式调用 `api.applyWindowEdit`；`Save As` 时通过 `sourcePath` 复制原文件再应用窗口补丁。普通文件走 `saveFileDialog`，写入后清除 `isDirty`。
  - `handleSearchResults`：创建或插入 `SearchTab`（若有 `parentSearchId` 则紧随父节点）。
  - `handleSearchResultSelect` + `ensureLineVisible`：双击搜索结果时会在滑窗中自动分页直到目标行可见。
  - `loadMoreContent(tabId, direction)`：
    - 普通截断文件：追加 `readFileRange` 返回的内容，直到 `hasMore === false`。
    - 窗口模式：替换 `content`，更新 `lineWindowStart`、`loadedRange`，并阻止在 `hasWindowEdits === true` 时切窗。
  - `jumpToFilePosition(tabId, ratio)`：配合滚动条跳转至文件任意位置。
  - `openFilesFromPaths`/`openFilesFromContent` 支持拖拽 blob，必要时通过 `readFilesFromBlobs` 读取文本。
  - 自动菜单绑定：`onMenuNewFile/open/save/saveAs`，组件卸载时删除所有搜索缓存（`close-tab` 与 `split-right` 事件由 `TabManager` 根据当前分栏状态单独处理）。
- `api.updateActiveContext` 在 `activeTab` 变化时更新主进程 `activeContext`，供搜索窗口了解 scope。

### 8.3 `TabManager` 组件（`components/TabManager.tsx`）

- VS Code 风格的分栏：
  - 维护 `SplitLayoutState = { panes: PaneState[]; focusedPaneId }`，`PaneState` 追踪 `tabIds`、`activeTabId` 与宽度比例，保证任意标签可在左右 pane 间拖拽或复制视图。
  - `Window ▸ Split Right (CmdOrCtrl+\)` 与标签右键菜单的 “Split Right” 都触发同一 `menu:split-right` 流程，自动在右侧 pane 打开当前/指定标签；首次拆分强制 50/50 宽度。
  - `File ▸ Close Tab`（或 `CmdOrCtrl+W`）、标签 `×`、右键菜单 “Close Tab” 均只关闭当前 pane 下的视图；如果该标签在其他 pane 仍存在则保持打开。
  - 分栏之间共享底层 `Tab` 数据，但滚动位置、行号视图、WindowedScrollbar 等按 `paneId::tabId` 组合键独立维护，确保同一文件在多 pane 中互不干扰。
  - 滑窗文件会为每个 `paneId::tabId` 分配独立的 `windowSessions`，每个 session 维护自己的 chunk、滚动位置与脏状态，因此 split 窗口的 minimap/custom scrollbar 可以单独跳转、互不影响。
  - 每个 pane 顶部的标签条支持拖拽重排/跨 pane 拖放，新建标签按钮、空白双击等操作会将 `pendingInsertionPane` 设置为目标 pane。
  - 标签右键菜单使用自定义 overlay（点击空白或按 Esc 关闭），并与拖拽/分栏 resize 等交互互斥以避免幽灵菜单。
- 维护多组 `ref`：
  - `editorRefs`, `highlightRefs`, `lineViewportRef`, `pendingScrollRatioRef`, `autoScrollIntentRef`。
  - `lineViewport` 通过 `requestAnimationFrame` 与 textarea 的滚动事件实时估算首行、偏移、可视行数（最多渲染 400 个行号）。
- 自定义行号与高亮：
  - `estimateLineNumberGutterWidth` 根据 `lineCount` 增加 gutter 宽度（最大 160px）。
  - `focusLine(tabId, line, column)` 负责滚动居中并在 2 秒后淡出高亮。
- 大文件 banner：
  - 仅在 `tab.isWindowed === false && tab.isTruncated === true` 时显示 read-only 横幅，包含字节/行统计与 “Load next chunk” 按钮。
  - 启用滑窗 (`tab.isWindowed === true`) 后隐藏横幅，窗口切换由滚动位置与 `WindowedScrollBar` 驱动。
- 标签栏关闭按钮：
  - 使用 `span` + `role="button"` + `tabIndex=0` 代替嵌套 `<button>`，既避免 HTML 语义冲突/水合报错，又在 Enter/Space 时调用 `closeTab` 并 `stopPropagation()`，防止误切换标签。
  - 滚动预览与滚动条：
    - `Minimap` 在右侧渲染 VS Code 风格的迷你地图，会采样最多 600 行文本并通过 `<canvas>` 绘制真实字符（自动压缩到 16 px 轨道内），拖拽、点击都会调用与滚动条相同的 `onSeek`，因此与 windowed/标准模式保持同步。
    - `WindowedScrollBar` 仍被复用两次（滑窗/普通模式），并与 `Minimap` 共用 4% 的最小 thumb 限制以避免拖动时的“回弹”体验。
    - 当 textarea 滚动到 95% 以上且仍有 `hasMore` 时自动触发 `loadMoreContent`；顶部 5% 会尝试向前加载窗口。
- 拖拽：
  - `collectDroppedFilePaths` 支持 `text/uri-list`、`text/plain`、`dataTransfer.files`；若缺乏路径则 `readFilesFromBlobs` 读取 blob 文本。
  - `resolveDroppedFilePath` 先读取 Electron `File.path`，若在 context isolation 下失效则调用 `window.electron.webUtils.getPathForFile(file)` 复原真实路径，避免 Finder 拖拽 fallback 到 blob 导致大文件进入只读模式。
- 搜索联动：
  - 监听 `api.onSearchNavigate`，在跳转前调用 `ensureLineVisible`。
  - `SearchResultsPanel` 始终保持 `opacity:1`（MutationObserver 强制）。
- 欢迎页 & 空状态：
  - `tabs === []` 时主区域展示欢迎提示；用户可双击标签栏空白创建新标签。

### 8.4 `SearchResultsPanel`

- 显示：
  - 顶部摘要包含 scope（workspace / nested）、查询/排除概览、命中数。
  - `groupMatchesByLine`：`dedupeLines === true` 时同一行只显示一次并以 `buildHighlightSegments` 渲染多段高亮；否则使用 `computeSnippet`。
- 交互：
  - 双击行或按 Enter 调用 `onSelectMatch`，由 `TabManager` 跳转并高亮。
  - 使用 `forwardRef` 暴露滚动容器，便于上层保持不透明度。
  - `totalMatches` 写入标签标题（例如 “Search: "foo" (42)”）。

### 8.5 滚动预览 & `WindowedScrollBar`

- `Minimap`：
  - 通过最多 600 行采样在 `<canvas>` 中绘制真实字符（每行最多 96 个字符，超出自动二分截断 + 添加省略号），让用户能在 16 px 轨道上看到实际文本结构而不仅是密度。
  - `normalizeThumbRange` 共享 helper，用 4% 最小视窗高度展示当前 viewport，拖拽/点击触发 `onSeek`。
  - 滑窗模式会调用 `jumpToFilePosition` 触发新的窗口读取；普通模式直接同步 textarea 滚动。
  - 拖动到轨道顶部或底部会自动吸附到整份文件的首/尾，并将 textarea 滚动到对应位置，避免加载最后一个 chunk 时出现反复跳动。
- `WindowedScrollBar`：
  - Props：`startRatio`、`endRatio`、`disabled`、`onSeek`。
  - Thumb 最小高度 4%，Pointer 事件驱动，利用 `normalizeThumbRange` 修复大文件拖动时的回弹。
  - 滑窗模式 `startRatio/endRatio` 取自 `tab.loadedRange / tab.size`；普通模式来自 `standardScrollMetricsRef`。

### 8.6 欢迎页、拖拽与粘性滚动

- 欢迎页提醒用户通过菜单创建/打开/搜索。
- 文本区域 `onDragOver/onDrop` 与根容器一致，避免阻塞系统拖放。
- 自定义滚动条（`index.css`) 隐藏浏览器原生滚动条，配合 `WindowedScrollBar` 使用。

---

## 9. 大文件窗口化

- 滑窗设计详见 `doc/large-file-windowing.md`：
  - 阈值、chunk 大小、窗口重叠、最大可视行数。
  - `read-file-range`/`apply-window-edit` 协议。
  - `loadMoreContent`/`jumpToFilePosition`/`ensureLineVisible` 算法。
  - `MAX_STREAM_MATCHES = 5000` 避免搜索结果爆炸。
- `windowSessions` 以 `paneId::tabId` 为 key 缓存各个 split pane 的窗口状态，同一文件可以在不同 pane 同时加载不同 chunk；保存/滚动等操作只影响当前 session，关闭 pane 时自动回收 session。
- `doc/memory-optimization-notes.md` 提供 40 MB+ 样本的 Activity Monitor 截图及验证 checklist，证明滑窗方案能稳定内存占用。

实现任何新的文件读取策略或 UI 变更时必须同步更新上述文档与本需求说明。

---

## 10. 搜索窗口（`src/renderer/src/search.*`）

- 表单字段：`query`（必填）、`exclude-query`、`regex`、`match-case`、`dedupe-lines`（默认 true）。
- `status` 提示使用 `data-state = idle | pending | success | error`，并在 `window` `focus/blur` 时通过 `--window-opacity` 显示前景/背景状态。
- `handleSearch()`：
  - 构造 `SearchRequest`（scope 根据 `window.api.onSearchContext` 的 `ActiveContext` 判定）。
  - 调用 `window.api.focusMainWindow()`，执行 `performSearch`，随后 `emitSearchResults`。
  - 根据返回结果更新提示文本（0 命中显示 “No matches found.”）。
- `queryInput` 初始化即获取焦点并选中当前文本。
- UI 风格：Inter 字体、渐变背景、毛玻璃卡片，宽度 <= 520px 时调整 padding/圆角。

---

## 11. 样式与设计系统

- 主窗口：
  - `src/renderer/src/index.css` 仅导入 Tailwind 并设定 `JetBrains Mono` 字体、自定义滚动条（完全隐藏滚动条轨迹，交给 `WindowedScrollBar`）。
  - UI 主色为浅灰/天蓝，`TabManager` 使用 Tailwind 原子类布局。
- 搜索窗口：
  - `search.css` 定义渐变背景、按钮阴影、`--window-opacity`。
  - 通过媒体查询适配窄窗口。
- 自定义高亮：`TabManager` 额外的 overlay `div` 使用 `bg-amber-200/60`，配合 JS 控制 opacity。
- 图标：`resources/icon.png` 作为 app icon，`src/renderer/src/assets/*` 提供附加 SVG。

---

## 12. 配置与构建要求

- `electron.vite.config.ts`：
  - `main/preload` 共用 `externalizeDepsPlugin`。
  - `renderer` 开启 React 插件、PostCSS（Tailwind + autoprefixer），`rollupOptions.input` 同时包含 `src/renderer/index.html` 和 `src/renderer/search.html`。
  - Alias `@renderer -> src/renderer/src`。
- `tailwind.config.js`：扫描 `./src/**/*.{js,ts,jsx,tsx}`。
- `tsconfig.node.json` / `tsconfig.web.json`：
  - node 侧 `types: ["electron-vite/node"]`。
  - web 侧 `jsx: react-jsx`、`paths["@renderer/*"]`、包含 `src/preload/*.d.ts`。
- `package.json`：
  - `"main": "./out/main/index.js"`。
  - `postinstall` 运行 `electron-builder install-app-deps`。
  - Scripts 已在 §3 列出。
- 打包：`electron-builder.yml`（未在此文件中，但需包含平台 icon、asar 设置等；遵循 electron-builder 文档）。

---

## 13. 复现清单

1. 使用 electron-vite (React + TS) 模板初始化工程，安装列出的依赖。
2. 创建 `src/common/ipc.ts`，定义所有共享类型与 `LogEditorApi`（包含 `readFileRange`、`applyWindowEdit` 等）。
3. 主进程模块化：
   - `window-manager.ts` 管理主/搜索窗口与上下文广播。
   - `menu.ts` 构建菜单并派发 `menu:*` 事件。
   - `ipc.ts` 实现文件对话框、拖拽读取、滑窗读取、窗口编辑、保存。
   - `search-service.ts` 支持正则/排除词/结果内搜索，并在 `isTruncated` + `filePath` 时流式扫描文件。
   - `index.ts` 负责生命周期与菜单重建。
4. 预加载层：
   - `index.ts` 通过 `contextBridge` 暴露 `window.api`，封装订阅/调用。
   - `index.d.ts` 扩展 `window.electron` 与 `window.api` 类型。
5. 渲染层：
   - `useTabsController` 管理所有标签状态、滑窗元数据、菜单快捷键、保存逻辑、搜索结果同步。
   - `TabManager` 渲染标签栏、欢迎页、textarea + 行号 + 高亮、`WindowedScrollBar`、大文件 banner、拖拽逻辑。
   - `SearchResultsPanel` + `WindowedScrollBar` + `search-utils` 构建搜索体验。
   - `search.ts` 实现独立窗口 UI 与 IPC。
6. 样式：导入 Tailwind，编写 `index.css`/`search.css`，保持滚动条/高亮效果。
7. 文档：更新 `doc/requirement.md`、`doc/memory-optimization-notes.md`、`doc/large-file-windowing.md` 以反映实现。
8. 验证流程：
   - 打开/拖拽多个日志，验证相同路径或同名文件去重并刷新内容。
   - 在 >2 MB 文件中滚动/拖动 `WindowedScrollBar`，观察横幅、窗口切换、自动加载、`Load next chunk` 按钮。
   - 编辑窗口内容并保存（包含 `Save As` 场景），确认 `apply-window-edit` 生效且搜索缓存刷新。
   - 搜索普通/正则/排除/嵌套查询，双击结果后主窗口正确跳转并高亮。
   - 同步搜索窗口上下文（活动文件/搜索标签）及快捷键菜单。
   - 关闭搜索标签或文件标签时，确认 `dispose-search-results`/`remove-tab-state` 被触发且不会泄漏缓存。
   - 运行 `npm run build` + `npm run build:{platform}` 验证打包。
