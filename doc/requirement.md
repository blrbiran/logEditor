# LogEditor Requirement

LogEditor 是一款基于 Electron + React + Tailwind CSS + TypeScript + electron-vite 的桌面日志查看与编辑工具。本文档以需求说明的角度描述架构、模块职责、进程间协议、搜索算法与 UI 约束。遵循此文档即可由 LLM 或人工复刻完整项目。

---

## 1. 项目目标与范围

- 面向日志调试与分析场景，提供多标签文本编辑、跨标签搜索、快速行定位与高亮提示。
- 桌面端原生体验：窗口管理遵循平台规范，并支持 macOS / Windows / Linux。
- 强调可维护的模块划分：主进程负责窗口与文件 I/O，预加载层暴露受控 API，渲染端实现业务 UI 与状态。

---

## 2. 技术栈与版本要求

- Electron `^38.1.2`
- react + react-dom `^19.1.1`
- TypeScript `^5.9.2`，统一用于 main / preload / renderer
- electron-vite `^4.0.1`（HMR、双入口构建）
- Tailwind CSS `^4.1.16`，PostCSS 插件 `@tailwindcss/postcss` + `autoprefixer`
- ESLint `^9.36.0` + Prettier `^3.6.2`（继承 `@electron-toolkit` 规则）
- electron-builder `^25.1.8` 用于打包

---

## 3. 运行脚本

- `npm run dev`：启用 electron-vite 开发模式，主窗口与搜索窗口具备 HMR。
- `npm run build`：执行 Node/Web 双 tsconfig 类型检查后打包 main、preload、renderer。
- `npm start`：使用 `electron-vite preview` 运行构建产物。
- `npm run typecheck[:node|:web]`：独立类型检查。
- `npm run build:{mac|win|linux}`：构建 + 平台打包。

---

## 4. 工程结构

```
src/
├── main/
│   └── index.ts             # 主进程入口，窗口与 IPC 管理、搜索引擎
├── preload/
│   └── index.ts             # contextBridge，封装受控 API
└── renderer/
    ├── index.html           # 主窗口 HTML
    ├── search.html          # 搜索窗口 HTML
    └── src/
        ├── main.tsx         # ReactDOM 入口
        ├── App.tsx          # 根组件，挂载 TabManager
        ├── index.css        # 主窗口全局样式（Tailwind 指令 + scrollbar 定制）
        ├── env.d.ts         # 渲染进程类型定义，暴露 LogEditorApi
        ├── search.ts        # 搜索窗口脚本
        ├── search.css       # 搜索窗口样式
        └── components/
            └── TabManager.tsx # 多标签 UI、搜索展示与编辑行为
```

辅助配置：

- `electron.vite.config.ts`：为 main/preload 应用 `externalizeDepsPlugin`，renderer 设置 React 插件、Tailwind PostCSS 流程，并定义 `main`/`search` 双 HTML 入口；配置别名 `@renderer -> src/renderer/src`。
- `tailwind.config.js`：扫描 `./src/**/*.{js,ts,jsx,tsx}` 生成原子类。
- `resources/icon.png`：桌面应用图标。
- `tsconfig.node.json` 与 `tsconfig.web.json`：分别服务 Node/Electron 环境与浏览器环境。

---

## 5. 架构概览

1. **主进程 (Node/Electron 环境)**：负责应用生命周期、窗口创建、菜单、文件对话框、搜索计算（以内存中的标签快照为数据源）。
2. **预加载层 (contextBridge)**：暴露受控的 `LogEditorApi` 给渲染进程，提供对 IPC `invoke` / `send` 的类型安全封装，并拓展 `window.electron.path.basename`。
3. **渲染进程（React）**：渲染主窗口 UI，管理文件/搜索/欢迎标签状态，调用预加载 API 完成文件读写、搜索与状态同步。
4. **独立搜索窗口**：共享同一预加载脚本，通过 `perform-search` 调用主进程搜索引擎，将结果广播到主窗口并更新状态提示。

---

## 6. 主进程需求（`src/main/index.ts`）

### 6.1 生命周期

- 在 `app.whenReady()` 中：
  - `electronApp.setAppUserModelId('com.electron')`，满足 Windows 通知与任务栏要求。
  - 使用 `optimizer.watchWindowShortcuts` 改进快捷键体验（开发阶段 F12 打开 DevTools、禁用生产环境的刷新快捷键）。
  - 创建主窗口、注册 IPC、构建菜单。
- `app.on('activate')`：macOS Dock 重启窗口时重建主窗口并重建菜单。
- `app.on('window-all-closed')`：除 macOS 外关闭所有窗口直接退出。

### 6.2 窗口管理

- **主窗口**：
  - 尺寸 900×670，`autoHideMenuBar: true`，预加载脚本 `../preload/index.js`，禁用 sandbox（保留 contextIsolation）。
  - `ready-to-show` 后再显示；阻止 `window.open` 打开新 Electron 窗口，改为 `shell.openExternal`。
  - 开发模式加载 `process.env.ELECTRON_RENDERER_URL`，生产加载打包 HTML。
- **搜索窗口**：
  - 尺寸 420×528，父窗口是主窗口，禁用最小化/最大化/全屏，仅在主窗口存在时创建。
  - `did-finish-load` 时向窗口发送当前 `ActiveContext`（欢迎页/文件/搜索）。
  - 关闭后将 `searchWindow` 引用置空，复用窗口前先聚焦，并立即同步上下文。
- 使用 `getMainWindow`/`ensureMainWindow` 维护主窗口引用（过滤掉搜索窗口）。

### 6.3 菜单约束

- **File**：`New` (`Cmd/Ctrl+N`)、`Open…` (`Cmd/Ctrl+O`)、`Save` (`Cmd/Ctrl+S`)、`Save As…` (`Cmd/Ctrl+Shift+S`)、`Close Tab` (`Cmd/Ctrl+W`)；非 macOS 额外 `Quit`。
- **Edit**：`undo/redo/cut/copy/paste/selectAll`。
- **Search**：`Find…` (`Cmd/Ctrl+F`) → 调用 `createSearchWindow()`。
- **View**：开发模式 `Reload`，生产 `Force Reload`；共用 `toggleDevTools`、缩放、全屏。
- **Window**：平台相关（macOS 带 “Close Window” 快捷键）。
- 通过 `sendToRenderer(channel)` 将菜单动作广播给主窗口渲染进程。

### 6.4 进程间通信契约

| Channel | 方向 | Payload | 说明 |
| --- | --- | --- | --- |
| `open-file-dialog` | renderer → main (invoke) | - | 弹出多选文件对话框，返回 `{ filePath, content }[]`。 |
| `save-file-dialog` | renderer → main (invoke) | `SaveFilePayload` | 若未提供 `filePath`，弹出保存对话框；写入磁盘并返回 `{ canceled, filePath? }`。 |
| `perform-search` | renderer/search → main (invoke) | `SearchRequest` | 基于缓存标签或已有搜索结果执行搜索，返回 `SearchResponsePayload`。 |
| `sync-tab-state` | renderer → main | `SearchableTab` | 渲染端每次文件内容或标题变化后同步。 |
| `remove-tab-state` | renderer → main | `tabId: string` | 标签关闭时移除缓存。 |
| `display-search-results` | search renderer → main | `SearchResponsePayload` | 搜索窗口广播结果给主窗口。 |
| `navigate-to-file-line` | search renderer → main | `{ tabId, line, column? }` | 搜索窗口请求主窗口跳转定位。 |
| `open-search-window` | renderer → main | - | 触发（重新）打开搜索窗口。 |
| `dispose-search-results` | renderer → main | `searchId: string` | 搜索标签关闭时清理缓存。 |
| `update-active-context` | renderer → main | `ActiveContext` | 主窗口标签切换时同步给搜索窗口。 |
| `focus-main-window` | search renderer → main | - | 搜索窗口提交前拉起主窗口。 |
| `menu:*` | main → renderer | - | 菜单广播 (`menu:new-file`, `menu:open-file`, `menu:save-file`, `menu:save-file-as`, `menu:close-tab`)。 |
| `search:results` | main → renderer | `SearchResponsePayload` | 主进程将搜索结果转发给主窗口。 |
| `search:navigate` | main → renderer | `{ tabId, line, column? }` | 搜索窗口触发跳转后回传给主窗口。 |
| `search:context` | main → search renderer | `ActiveContext` | 搜索窗口根据上下文决定工作模式。 |

### 6.5 搜索引擎与缓存

- `tabStore: Map<string, SearchableTab>`：持有所有打开文件的最新内容（来自渲染进程同步）。
- `searchResultsStore: Map<string, StoredSearchResultSet>`：按 `searchId` 缓存历史搜索结果，支持“在结果中再次搜索”。
- `activeContext: ActiveContext`：记录主窗口当前关注的标签，用于告知搜索窗口当前是“全局搜索”还是“结果内搜索”。
- 搜索算法：
  - 入参 `SearchRequest` 支持 `query`、`isRegex`、`matchCase`、`excludeQuery`、`scope`、`dedupeLines`。
  - 若 `isRegex` 为真，在 `perform-search` 中构造 `matcher`，兼容大小写选项；若正则非法会抛出错误。
  - 支持可选的排除表达式：正则模式下构造 `excludeMatcher`；普通模式下以大小写敏感或不敏感的包含判断跳过整行。
  - `scope.kind === 'search'` 时，从 `searchResultsStore` 获取基础结果集合，使用 `filterSearchResults` 重新匹配；否则遍历所有缓存标签。
  - `findMatches` 会逐行扫描，返回行号、列号、匹配文本与原始行内容；对正则零长度匹配做递增处理避免死循环。
- 每次生成 `SearchResponsePayload` 后保存到 `searchResultsStore`，以便搜索窗口 refine 时复用；`dispose-search-results` 接收到 `searchId` 后删除缓存。

---

## 7. 预加载层需求（`src/preload/index.ts`）

- 通过 `contextBridge` 暴露两个对象：
  - `window.electron`：在 `@electron-toolkit/preload` 的 `electronAPI` 基础上拓展 `path.basename`。
  - `window.api: LogEditorApi`：封装所有 `invoke` / `send` / 订阅方法。
- 关键实现：
  - `subscribe(channel, listener)`：统一包装 `ipcRenderer.on`，返回解除订阅函数，确保渲染进程组件卸载时可清理。
  - `invoke(channel, payload?)`：泛型约束返回 Promise。
  - API 方法覆盖文件对话框、搜索执行、状态同步、菜单监听、搜索结果广播、上下文同步、主窗口聚焦等。
- 当 `process.contextIsolated` 为 false 时兜底写入全局变量，保持 API 可用。

`LogEditorApi` 类型（节选）：

```ts
export interface LogEditorApi {
  openFileDialog(): Promise<{ filePath: string; content: string }[]>
  saveFileDialog(payload: SaveFilePayload): Promise<SaveFileResult>
  performSearch(payload: SearchRequest): Promise<SearchResponsePayload>
  syncTabState(tab: SearchableTab): void
  removeTabState(tabId: string): void
  emitSearchResults(payload: SearchResponsePayload): void
  emitNavigateToLine(payload: { tabId: string; line: number; column?: number }): void
  openSearchWindow(): void
  focusMainWindow(): void
  disposeSearchResults(searchId: string): void
  updateActiveContext(context: ActiveContext): void
  // ... onMenu*, onSearchResults, onSearchNavigate, onSearchContext
}
```

---

## 8. 渲染进程（主窗口 React）

### 8.1 标签模型

`TabManager` 管理三类标签：

- `FileTab`：打开或新建文件。字段包含 `id`, `title`, `filePath?`, `content`, `isDirty`, `isActive`。
- `SearchTab`：展示搜索结果。字段包含 `id`, `title`, `request`, `parentSearchId?`, `results`, `totalMatches`, `isActive`。
- `WelcomeTab`：默认欢迎页，id 固定为 `welcome-tab`。

常量：

- `generateTabId()` 使用 `crypto.randomUUID()`（或降级到时间戳拼接）。
- `buildDefaultFilename()` 根据标题生成 `.log` 扩展的默认文件名。
- `buildSearchTabTitle()` / `describeScopeDetail()` / `formatSearchQuery()` 用于渲染搜索标签标题与描述。

### 8.2 标签行为与状态同步

- 默认状态：仅包含激活的欢迎标签。
- 双击标签栏空白区域会调用 `createNewTab()` 新建文件标签。
- 文件打开流程：
  - `openFiles()` 调用 `api.openFileDialog()` 获取多个文件。
  - 若文件已存在标签，则更新内容并激活；否则创建新标签（使用 `window.electron.path.basename` 作为标题）。
- 保存流程：
  - `handleSave(forceSaveAs)` 根据布尔参数决定是否强制弹出另存为。
  - 保存成功后更新 `filePath`、标题与 `isDirty`。
- 关闭行为：
  - `closeTab(tabId)` 移除标签；若为空则恢复欢迎页。
  - 自动选择关闭标签左侧或第一个剩余标签作为新的激活标签。
  - 文件标签关闭时调用 `api.removeTabState`；搜索标签关闭时调用 `api.disposeSearchResults`。
- 菜单与搜索事件：
  - 在 `useEffect` 中注册 `api.onMenu*`、`api.onSearchResults`、`api.onSearchNavigate`。
  - 搜索结果到达时创建新的 `SearchTab`。若是嵌套搜索（存在 `parentSearchId`），新标签插入在父标签之后。
- 状态同步：
  - 每当 `tabs` 更新，对所有 `FileTab` 调用 `api.syncTabState` 保持主进程缓存。
  - `activeTabId` 改变时调用 `api.updateActiveContext`，通知主进程当前上下文（欢迎/文件/搜索）。

### 8.3 文本编辑区与高亮

- 布局：左侧固定宽度 56px 的行号栏，右侧 textarea 使用 `editor-scrollbar` 自定义滚动条。
- `focusLine(tabId, line, column)`：定位到目标行列时
  - 计算 textarea selection range；
  - 通过滚动保证目标行垂直居中；
  - 更新行号栏 `transform`，保证行号随滚动锁定；
  - 控制 overlay `<div>` 设置 `top/height` 并两秒后淡出（`opacity`）。
- `useEffect`：监听 textarea `scroll` 更新行号与高亮位置；组件卸载时清理 timeout、释放搜索结果缓存。

### 8.4 搜索标签渲染

- 顶部摘要显示搜索模式、查询词、排除条件、匹配统计。
- 结果列表：
  - `groupMatchesByLine()` 根据 `dedupeLines`（默认 true）决定是否将同一行的多个匹配合并。
  - 合并模式下使用 `buildHighlightSegments()` 对预览行切片，匹配部分以 `bg-amber-200` 高亮；未合并时构建前后文 snippet。
  - 双击或按 Enter 时调用 `handleSearchResultSelect()` 激活对应文件标签并滚动高亮。
- 保证搜索容器透明度：
  - 使用 `MutationObserver` 防止其他样式覆盖 `opacity`，并在鼠标滚动/进入/离开时强制保持 `1`。

### 8.5 欢迎页

- 居中排版，提示通过 File 菜单创建/打开日志，并提醒可使用 Search 菜单。

---

## 9. 搜索窗口（`src/renderer/search.*`）

- **HTML 布局**：`search.html` 定义表单字段：
  - `query`（必填）、`exclude-query`（可选）、`regex`、`match-case`、`dedupe-lines`（默认开启）。
  - 表单底部展示状态消息，ARIA `role="status"`，`data-state` 区分 `idle/pending/success/error`。
  - `<script type="module" src="/src/search.ts">` 作为入口。
- **样式**：`search.css`
  - 使用 `--window-opacity` 控制窗口聚焦时的不透明度；按钮渐变、磨砂卡片风格。
  - 响应式：宽度 <= 520px 时调整内边距与圆角。
- **脚本逻辑** (`search.ts`)：
  - 初始时聚焦 `query`，同步上下文提示。
  - 监听 `window.api.onSearchContext` 更新 `currentContext`（`workspace` 或 `search`）。
  - `handleSearch()`：
    - 构造 `SearchRequest`（含 `dedupeLines` 与 `excludeQuery`）。
    - `window.api.focusMainWindow()` 以确保主窗口在前台。
    - 调用 `window.api.performSearch()`，随后 `window.api.emitSearchResults()` 将结果推送给主窗口。
    - 根据匹配数量更新状态文本；异常时展示错误消息。
  - 监听窗口 `focus/blur` 调整 `--window-opacity`，提供视觉反馈。

---

## 10. 样式与设计系统

- 主窗口依赖 Tailwind 原子类；`src/renderer/src/index.css` 导入 `@tailwindcss` 并定义 monospace 字体、浅色背景。
- 自定义滚动条（`editor-scrollbar`）使用浅蓝滑块与圆角轨道。
- 搜索窗口使用独立的 `Inter` 字体族、渐变背景，与主界面保持一致的配色体系。
- 行号与高亮 overlay 通过内联样式动态控制位置与透明度。

---

## 11. 配置与构建要求

- `electron.vite.config.ts`：
  - renderer `build.rollupOptions.input` 必须同时包含 `src/renderer/index.html` 与 `src/renderer/search.html`，以生成两个窗口入口。
  - renderer PostCSS 管线包含 `tailwindcss` 与 `autoprefixer`。
  - 通过别名 `@renderer` 简化相对路径引用。
- `tailwind.config.js`：扫描 `src` 目录下所有 JS/TS/JSX/TSX 文件。
- `tsconfig.node.json` / `tsconfig.web.json`：分别针对 Electron 主进程与浏览器上下文配置编译目标；`tsconfig.web.json` 需包含 `"types": ["vite/client"]` 以支持 HMR。
- `package.json`：
  - `main` 指向构建后 `./out/main/index.js`。
  - `postinstall` 钩子运行 `electron-builder install-app-deps`。

---

## 12. 复现清单

1. 初始化 electron-vite 模板，启用 React + TypeScript，并添加 Tailwind/PostCSS 配置。
2. 实现主进程 `index.ts`：
   - 创建主/搜索窗口，配置菜单与窗口选项；
   - 建立完整的 IPC 通道与搜索算法（含正则、大小写、排除与嵌套搜索）。
3. 编写预加载脚本：
   - 通过 `contextBridge` 暴露 `LogEditorApi` 与扩展的 `window.electron.path.basename`。
4. 构建 React 渲染层：
   - 创建 `TabManager` 组件，落实标签生命周期、文件读写、状态同步、菜单响应与搜索标签逻辑；
   - 实现行号栏、滚动定位与高亮 overlay；
   - 提供欢迎页文案。
5. 创建搜索窗口：
   - HTML + CSS 构成独立界面；
   - `search.ts` 处理表单提交、上下文监听与窗口焦点效果。
6. 提供类型声明 `env.d.ts`，确保主/预加载/渲染三端在 TypeScript 下共享 `LogEditorApi`、`SearchRequest` 等结构。
7. 验证：
   - 新建、打开、保存、另存、关闭标签；
   - 搜索窗口执行普通/正则/排除/嵌套搜索；
   - 搜索结果双击可定位到文本并显示高亮；
   - 关闭搜索标签会释放缓存，刷新后仍能恢复已经打开的文件内容。

严格遵守以上条目即可完整复刻当前 LogEditor 项目。
