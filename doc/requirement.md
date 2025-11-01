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
├── common/
│   └── ipc.ts               # 共享的 IPC 契约、类型别名、预加载 API 定义
├── main/
│   ├── index.ts             # 主进程入口，仅负责生命周期 orchestrate
│   ├── window-manager.ts    # 主/搜索窗口创建、聚焦与上下文广播
│   ├── menu.ts              # 应用菜单模板与命令触发
│   ├── search-service.ts    # 搜索引擎、标签快照缓存、结果集管理
│   └── ipc.ts               # IPC 注册，桥接窗口管理与搜索服务
├── preload/
│   ├── index.ts             # contextBridge，封装受控 API
│   └── index.d.ts           # 运行时全局声明，引用共享 LogEditorApi 类型
└── renderer/
    ├── index.html           # 主窗口 HTML
    ├── search.html          # 搜索窗口 HTML
    └── src/
        ├── main.tsx         # ReactDOM 入口
        ├── App.tsx          # 根组件（挂载 TabManager）
        ├── index.css        # 主窗口全局样式（Tailwind 指令 + scrollbar 定制）
        ├── env.d.ts         # 渲染进程类型 re-export（来自 common/ipc.ts）
        ├── search.ts        # 搜索窗口逻辑
        ├── search.css       # 搜索窗口样式
        └── components/
            ├── TabManager.tsx         # 主 UI 容器，组合 hooks 与子组件
            └── tab-manager/
                ├── useTabsController.ts # 标签状态、菜单事件、IPC 同步 hook
                ├── SearchResultsPanel.tsx # 搜索结果列表与摘要
                ├── helpers.ts           # ID/文件名/数值工具函数
                ├── search-utils.ts      # 搜索标签标题、片段分组、高亮工具
                ├── tab-types.ts         # Tab 类型守卫与常量
                └── constants.ts         # Tab 相关常量（行号 gutter 等）
```

辅助配置：

- `electron.vite.config.ts`：为 main/preload 应用 `externalizeDepsPlugin`，renderer 设置 React 插件、Tailwind PostCSS 流程，并定义 `main`/`search` 双 HTML 入口；配置别名 `@renderer -> src/renderer/src`。
- `tailwind.config.js`：扫描 `./src/**/*.{js,ts,jsx,tsx}` 生成原子类。
- `resources/icon.png`：桌面应用图标。
- `tsconfig.node.json` 与 `tsconfig.web.json`：分别服务 Node/Electron 环境与浏览器环境。

---

## 5. 架构概览

1. **共享契约 (`src/common/ipc.ts`)**：集中声明 `SearchRequest`、`SearchResponsePayload`、`ActiveContext`、`LogEditorApi` 等类型，供 main / preload / renderer 共用，确保 IPC 协议与桥接 API 一致。
2. **主进程 (Node/Electron 环境)**：通过 `window-manager` 管理窗口生命周期，`menu` 负责菜单模板，`search-service` 提供搜索引擎与缓存，`ipc` 注册渠道；`index.ts` 作为 orchestrator。
3. **预加载层 (contextBridge)**：在 `index.ts` 中暴露受控的 `LogEditorApi`，复用共享类型并在 `index.d.ts` 中声明 window 全局。
4. **渲染进程（React）**：`TabManager` 组合 `useTabsController` 与 `SearchResultsPanel` 等子模块，完成标签状态管理、编辑器渲染与搜索结果展示。
5. **独立搜索窗口**：共享预加载 API，使用轻量 DOM 脚本发起搜索请求并回传结果。

---

## 6. 主进程需求

### 6.1 入口 orchestrator（`src/main/index.ts`）

- 持有全局 `activeContext` 状态（记录当前聚焦的欢迎/文件/搜索页）。
- 实例化 `searchService = createSearchService()` 与 `windowManager = createWindowManager({ getActiveContext })`。
- 在 `app.whenReady()` 中：
  - 调用 `electronApp.setAppUserModelId('com.electron')`，满足 Windows 要求。
  - 通过 `optimizer.watchWindowShortcuts` 统一快捷键行为（开发环境允许 F12，生产阻止强制刷新）。
  - `windowManager.createMainWindow()` 启动主窗口。
  - `registerIpcHandlers({ windowManager, searchService, setActiveContext })` 注册 IPC。
  - `buildApplicationMenu({ sendToRenderer, openSearchWindow })` 构建菜单。
- 监听 `app.on('activate')`：若窗口全部关闭（macOS）重新创建主窗口并重建菜单。
- 监听 `app.on('window-all-closed')`：非 macOS 平台直接退出。
- `setActiveContext` 同步更新 `activeContext` 并委托 `windowManager.sendSearchContext` 将上下文广播到搜索窗口。

### 6.2 窗口管理器（`src/main/window-manager.ts`）

- 维护 `mainWindow` 与 `searchWindow` 引用，暴露：
  - `createMainWindow()`：创建 900×670 主窗口，设置 `autoHideMenuBar`、预加载脚本 `../preload/index.js`，阻止 `window.open`，按环境加载 URL 或本地 HTML。
  - `openSearchWindow()`：在主窗口存在时创建 420×528 搜索子窗，加载 `search.html`，并在 `did-finish-load` 后推送当前 `ActiveContext`。
  - `sendToRenderer(channel, payload)`：向主窗口广播事件。
  - `focusMainWindow()`：恢复/聚焦主窗口。
  - `sendSearchContext(context)`：若搜索窗口存在则推送上下文。
  - `getMainWindow()` / `ensureMainWindow()`：过滤掉搜索窗口，返回主窗口实例。

### 6.3 菜单模块（`src/main/menu.ts`）

- `buildApplicationMenu({ sendToRenderer, openSearchWindow })` 构建模板，结构为 `File / Edit / Search / View / Window (+ App on macOS)`。
- 菜单项通过注入的 `sendToRenderer` 派发 `menu:new-file`、`menu:open-file`、`menu:save-file`、`menu:save-file-as`、`menu:close-tab`。
- `Search › Find…` 调用依赖注入的 `openSearchWindow()`。
- 根据 `is.dev` 决定使用 `reload` 或 `forceReload`。

### 6.4 搜索服务（`src/main/search-service.ts`）

- 内部维护：
  - `tabStore: Map<string, SearchableTab>`：存储渲染端同步的标签快照。
  - `searchResultsStore: Map<string, StoredSearchResultSet>`：缓存历史搜索结果，支持结果内再次搜索。
- `performSearch(request)`：
  - 调用 `normalizeRequest` 统一空白 trimming 和默认 scope/dedupe。
  - `buildMatchers` 根据正则/大小写构造 `matcher` 与 `excludeMatcher`。
  - 若 scope 为 `search`，从缓存结果中过滤；否则遍历 `tabStore`，调用 `findMatches` 扫描文本。
  - 生成 `SearchResponsePayload`（含新 `searchId`、父搜索 ID、结果集合）并写入缓存。
- `findMatches`：逐行遍历文本，处理正则/普通匹配、排除条件、零长度匹配补偿。
- `filterSearchResults`：对已有搜索结果执行二次匹配，聚合行级别的匹配。
- 其他 API：
  - `syncTabState(tab)` / `removeTabState(tabId)`：更新/删除 `tabStore`。
  - `disposeSearchResults(searchId)`：删除对应缓存。
  - `updateTabContentByFilePath(filePath, content)`：保存文件后刷新缓存内容。

### 6.5 IPC 注册（`src/main/ipc.ts`）

- 统一绑定 `ipcMain.handle/on`：
  - `open-file-dialog`：使用 `dialog.showOpenDialog` 读取多个文件，返回 `{ filePath, content }[]`。
  - `save-file-dialog`：根据 payload 保存文件；若无路径则弹出保存对话框；成功后调用 `searchService.updateTabContentByFilePath`。
  - `perform-search`：委托 `searchService.performSearch`，失败时记录错误。
  - `sync-tab-state` / `remove-tab-state`：同步标签缓存。
  - `display-search-results`、`navigate-to-file-line`：将搜索窗口结果/导航请求转发给主窗口。
  - `open-search-window`、`focus-main-window`：调用窗口管理器。
  - `dispose-search-results`：清理缓存。
  - `update-active-context`：调用 `setActiveContext` 触发广播。
- `ping` 通道保留调试用途。

### 6.6 IPC 通道总览

| Channel | 方向 | Payload | 说明 |
| --- | --- | --- | --- |
| `open-file-dialog` | renderer → main (invoke) | - | 弹出多选文件对话框，返回 `{ filePath, content }[]`。 |
| `save-file-dialog` | renderer → main (invoke) | `SaveFilePayload` | 若未提供 `filePath`，弹出保存对话框；写入磁盘后返回 `{ canceled, filePath? }`。 |
| `perform-search` | renderer/search → main (invoke) | `SearchRequest` | 基于缓存标签或历史搜索执行计算，返回 `SearchResponsePayload`。 |
| `sync-tab-state` | renderer → main | `SearchableTab` | 文本变更时同步标签快照。 |
| `remove-tab-state` | renderer → main | `tabId: string` | 标签关闭时移除缓存。 |
| `display-search-results` | search renderer → main | `SearchResponsePayload` | 搜索窗口把结果广播给主窗口。 |
| `navigate-to-file-line` | search renderer → main | `{ tabId, line, column? }` | 请求主窗口跳转并高亮。 |
| `open-search-window` | renderer → main | - | 打开（或聚焦）搜索窗口。 |
| `dispose-search-results` | renderer → main | `searchId: string` | 搜索标签关闭时清理缓存。 |
| `update-active-context` | renderer → main | `ActiveContext` | 主窗口标签切换时同步上下文。 |
| `focus-main-window` | search renderer → main | - | 搜索窗口提交前拉起主窗口。 |
| `menu:*` | main → renderer | - | 菜单广播 (`menu:new-file` 等)。 |
| `search:results` | main → renderer | `SearchResponsePayload` | 主进程把搜索结果推送给主窗口。 |
| `search:navigate` | main → renderer | `{ tabId, line, column? }` | 主进程将搜索窗口的跳转指令发送给主窗口。 |
| `search:context` | main → search renderer | `ActiveContext` | 搜索窗口根据上下文决定“全局/嵌套”模式。 |

---

## 7. 预加载层需求（`src/preload/index.ts` + `index.d.ts`）

- 复用 `src/common/ipc.ts` 中声明的类型：
  - `LogEditorApi`、`SearchRequest`、`SearchResponsePayload`、`ActiveContext` 等。
  - `index.d.ts` 将 `window.api` 显式标注为 `LogEditorApi`，`window.electron` 扩展自 `ElectronAPI`。
- `index.ts` 通过 `contextBridge` 暴露：
  - `window.electron`：基于 `electronAPI` 增补 `path.basename`，供渲染层识别文件名。
  - `window.api`：完全按照共享接口实现，类型安全地封装 `invoke` 与 `ipcRenderer.send`。
- 工具函数：
  - `subscribe(channel, listener)`：统一监听器注册，返回解除订阅函数，确保 React `useEffect` 可清理。
  - `invoke<Result>(channel, payload?)`：包装 `ipcRenderer.invoke` 并回传泛型。
- API 能力覆盖：文件对话框、保存对话框、搜索执行、标签同步与移除、搜索结果广播、菜单/搜索事件监听、主窗口聚焦、上下文同步等。
- 若禁用 `contextIsolation`，仍兜底将对象挂到 `window`，保证兼容性。

`LogEditorApi` 类型（节选，与渲染端共享）：

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

### 8.1 标签类型与工具

- `tab-manager/tab-types.ts`：声明 `FileTab`、`SearchTab`、`WelcomeTab` 及类型守卫，常量 `WELCOME_TAB_ID`。
- `tab-manager/helpers.ts`：提供 `generateTabId()`（首选 `crypto.randomUUID`）与 `buildDefaultFilename()`、`clamp()`、`truncate()` 等工具。
- `tab-manager/constants.ts`：集中保存 UI 常量（如 `LINE_NUMBER_GUTTER_WIDTH = 56`）。
- `tab-manager/search-utils.ts`：处理搜索标签显示逻辑，包括 `buildSearchTabTitle`、`describeScopeDetail`、`groupMatchesByLine`、`buildHighlightSegments`、`computeSnippet` 等。

### 8.2 `useTabsController` hook（`tab-manager/useTabsController.ts`）

- 管理标签状态、活动标签 ID、引用缓存：
  - 初始状态为欢迎页；`tabsRef` 与 `activeTabIdRef` 用于跨闭包读取最新值。
  - `createNewTab()` 在双击空白标签栏或菜单触发时创建新文件标签。
  - `openFiles()` 调用 `api.openFileDialog()`，复用已打开标签或新建标签并激活。
  - `handleSave(forceSaveAs)` 依据当前激活文件调用 `api.saveFileDialog()`，更新标题/路径/脏标记。
  - `closeTab()`/`closeActiveTab()` 处理标签关闭、欢迎页回退及缓存清理（文件调用 `api.removeTabState`，搜索调用 `api.disposeSearchResults`）。
  - `handleSearchResults()` 创建/插入 `SearchTab`，支持按父搜索 ID 插入到父标签之后。
  - `handleSearchResultSelect(result, match)` 激活对应文件标签，供外层组件高亮定位。
- 副作用：
  - 每次 `tabs` 变化时调用 `api.syncTabState()` 同步内容缓存。
  - 活动标签变化时构建 `ActiveContext` 并调用 `api.updateActiveContext()`。
  - 组件卸载时自动释放所有搜索结果缓存。
- 菜单与 IPC 监听：
  - 通过 `api.onMenu*` 绑定菜单快捷方式。
  - 监听 `api.onSearchResults` 处理搜索结果。

### 8.3 `TabManager` 组件（`components/TabManager.tsx`）

- 负责组合 UI 与高亮逻辑：
  - 使用 `useTabsController` 获取状态与操作。
  - 维护 `editorRefs`、`highlightRefs`、`lineNumberRefs`、`highlightInfoRef`、`highlightTimeoutRef` 等引用，渲染 textarea 与高亮 overlay。
  - `focusLine(tabId, line, column)`：计算光标位置、滚动居中、同步行号滚动，并在 2 秒后淡出高亮。
  - `useEffect`：
    - 监听激活标签变化，随滚动重新定位高亮层。
    - 监听 `api.onSearchNavigate`（来自主进程转发的搜索窗口请求），切换标签并调用 `focusLine`。
    - 管理搜索结果容器的透明度（通过 `MutationObserver` 保持 `opacity:1`）。
  - 渲染逻辑：
    - 标签栏按钮使用 Tailwind 样式，双击空白区域创建新标签。
    - 文件标签区域包含行号列（随着滚动调整 transform）与内容 textarea。
    - 搜索标签交由 `SearchResultsPanel` 渲染，欢迎标签使用居中文案。

### 8.4 `SearchResultsPanel` 组件（`tab-manager/SearchResultsPanel.tsx`）

- 接收 `SearchTab` 与 `onSelectMatch` 回调：
  - 顶部摘要展示搜索模式、查询词、排除条件、命中统计。
  - 结果列表按文件遍历，显示匹配数与匹配片段。
  - 当 `dedupeLines` 为真时，以 `buildHighlightSegments` 渲染行内多段高亮；否则使用 `computeSnippet` 显示前后文。
  - 双击或回车触发 `onSelectMatch(result, match)`，交由 `TabManager` 定位。
  - 使用 `ref` 暴露给 `TabManager`，以统一控制滚动容器透明度。

### 8.5 欢迎页与编辑体验

- 欢迎页内容提醒用户使用菜单创建/打开日志或调用搜索。
- 文本编辑区采用 `editor-scrollbar` 自定义滚动条（浅蓝色滑块），并按等宽字体渲染。
- 行号与高亮 overlay 使用绝对定位结合 scroll 事件调整，保证高亮与内容同步。

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
2. 创建 `src/common/ipc.ts`，集中定义所有跨进程共享类型与 `LogEditorApi` 接口。
3. 在主进程实现模块化结构：
   - `window-manager.ts` 管理主/搜索窗口生命周期；
   - `menu.ts` 构建菜单模板并派发菜单事件；
   - `search-service.ts` 编写文本搜索与缓存逻辑（含结果内搜索、排除、正则支持）；
   - `ipc.ts` 注册全部 IPC 通道，协调窗口管理与搜索服务；
   - `index.ts` 在 Electron 生命周期内 orchestrate 并维护 `activeContext`。
4. 编写预加载层：
   - `index.ts` 使用 `contextBridge` 暴露类型安全的 `window.api` 与 `window.electron`；
   - `index.d.ts` 扩展全局声明并引用共享类型。
5. 构建 React 渲染层：
   - 实现 `useTabsController` hook 处理标签状态、菜单事件、IPC 同步；
   - 使用 `TabManager.tsx` 组合编辑器、高亮逻辑与 `SearchResultsPanel`；
   - 提供 `tab-manager` 目录下的辅助模块（类型、常量、搜索工具）。
6. 创建搜索窗口：
   - `search.html` + `search.css` 渲染界面；
   - `search.ts` 调用预加载 API 执行搜索、聚焦主窗口并展示状态。
7. 确保 `src/renderer/src/env.d.ts` re-export 共享类型，为 React 组件提供类型提示。
8. 验证功能流程：
   - 新建、打开、保存、另存、关闭标签；
   - 搜索窗口执行普通/正则/排除/嵌套搜索，结果可在主窗口新标签中展示；
   - 搜索结果双击或菜单导航可定位到文本并显示高亮；
   - 关闭搜索标签释放缓存，重新打开仍能保留已激活文件内容。

严格遵守以上条目即可完整复刻当前 LogEditor 项目。
