# LogEditor Requirement

LogEditor 是一个基于 Electron 的桌面日志查看与编辑器，提供多标签文件管理、跨文件搜索和直观的行高亮体验。本文档详述工程结构、关键模块与进程间协议，使读者可以凭此复刻应用。

## 1. 技术栈与版本

- **桌面框架**：Electron ^38.1.2，管理主进程、预加载脚本与渲染进程。
- **构建工具**：electron-vite ^4.0.1，统一打包 main、preload、renderer，并提供开发期 HMR。
- **前端框架**：React ^19.1.1（搭配 ReactDOM 19）构建渲染进程 UI。
- **语言**：TypeScript ^5.9 应用于全部进程。
- **样式体系**：Tailwind CSS ^4.1.16 与 PostCSS（tailwindcss + autoprefixer 插件）。
- **包管理与脚本**：npm，`package.json` 维护开发/构建/打包命令。
- **代码质量**：ESLint 9 + Prettier 3（继承 `@electron-toolkit` 规则）。

常用脚本：

- `npm run dev`：启动 electron-vite 开发环境，主窗口与搜索窗口开启热刷新。
- `npm run build`：执行 `typecheck` 后构建全部入口。
- `npm start`：使用 `electron-vite preview` 运行构建产物。
- `npm run typecheck`：分别对 Node (`tsconfig.node.json`) 与 Web (`tsconfig.web.json`) 进行类型检查。

## 2. 工程结构

源码集中在 `src/`，按进程职责拆分目录：

```
src/
├── main/                  # 主进程 (Node 环境)
│   └── index.ts           # 应用入口、窗口/菜单管理、IPC 服务
├── preload/               # 预加载脚本 (隔离上下文的桥梁)
│   └── index.ts           # 暴露安全 API，封装 ipcRenderer
└── renderer/              # 渲染进程 (浏览器环境)
    ├── index.html         # 主窗口 HTML 模板
    ├── search.html        # 搜索窗口 HTML 模板
    └── src/
        ├── main.tsx       # React 入口
        ├── App.tsx        # 根组件（挂载 TabManager）
        ├── index.css      # 全局样式 (Tailwind 指令 + 自定义样式)
        ├── search.ts      # 搜索窗口逻辑
        ├── search.css     # 搜索窗口样式
        ├── env.d.ts       # 渲染进程全局类型声明
        └── components/
            └── TabManager.tsx  # 核心 UI 与状态逻辑
```

重要配置文件：

- `electron.vite.config.ts`：声明 React 插件、Tailwind PostCSS 管线，设置 renderer 的 `main`/`search` 双入口以及别名 `@renderer -> src/renderer/src`。
- `tailwind.config.js`：扫描 `src/**/*.{js,ts,jsx,tsx}` 生成所需原子类。
- `resources/icon.png`：桌面应用图标资源。
- `electron-builder.yml` / `dev-app-update.yml`：应用打包与自动更新相关配置（源码未直接引用，但打包阶段会使用）。

## 3. 主进程 (`src/main/index.ts`)

### 3.1 应用生命周期

- `app.whenReady()`：设置 Windows App User Model ID，注册开发者快捷键优化 (`optimizer.watchWindowShortcuts`)，随后创建主窗口、注册 IPC、构建菜单。
- `app.on('activate')`：macOS 上在所有窗口关闭后重新点击 Dock 图标时重建主窗口。
- `app.on('window-all-closed')`：非 macOS 平台关闭所有窗口时退出应用。

### 3.2 窗口创建

- `createMainWindow()`：创建 900×670 的主窗口，隐藏菜单栏，设置 `preload` 为 `../preload/index.js`，关闭 sandbox（保持 `contextIsolation` 默认开启），加载开发地址或打包后的 `renderer/index.html`。
- `createSearchWindow()`：仅在主窗口存在时创建尺寸 420×220 的无模式子窗口。开发模式加载 `ELECTRON_RENDERER_URL/search.html`，生产模式加载 `renderer/search.html`。关闭时将 `searchWindow` 置空。
- `getMainWindow()` / `ensureMainWindow()`：维护主窗口引用，当引用失效时从现有窗口列表中寻找除搜索窗口以外的实例。

### 3.3 菜单结构

`buildApplicationMenu()` 生成跨平台菜单模板：

- **File**：`New`, `Open…`, `Save`, `Save As…`, `Close Tab`，Windows/Linux 补充 `Quit`。
- **Edit**：标准撤销/重做与剪贴板操作。
- **Search**：`Find…`，触发搜索窗口。
- **View**：开发模式 `Reload`，生产模式 `Force Reload`，另含 DevTools、缩放、全屏。
- **Window**：平台相关窗口管理项 (macOS 包含 “Close Window” 快捷键)。

所有菜单项通过 `sendToRenderer(channel)` 将指令广播给活跃渲染进程。

### 3.4 状态缓存与文件操作

- `tabStore: Map<string, SearchableTab>` 持久化渲染端同步的标签页，键为 tabId。用于跨窗口搜索及保存后更新缓存。
- `ipcMain.handle('open-file-dialog')`：弹出文件选择器（允许多选日志/任意文件），按 UTF-8 读取内容并返回 `{ filePath, content }[]`。
- `ipcMain.handle('save-file-dialog')`：接收 `{ filePath?, defaultPath?, content }`，若无目标路径则弹出保存对话框；写入磁盘后更新对应标签缓存。

### 3.5 搜索通道

- `ipcMain.handle('perform-search')`：接收 `SearchRequest { query, isRegex, matchCase }`，针对 `tabStore` 中所有标签执行 `findMatches()`，返回 `SearchResponseItem[]`。
- `findMatches()`：逐行处理文本，正则模式下复制 `RegExp` 并迭代 `exec`，普通匹配使用大小写条件下的 `indexOf` 循环，生成 `{ line, column, match, preview }`。

### 3.6 IPC 协议

| 通道 | 类型 | 方向 | 描述 |
| --- | --- | --- | --- |
| `open-file-dialog` | `ipcMain.handle` | renderer → main | 打开文件，返回已读取内容。 |
| `save-file-dialog` | `ipcMain.handle` | renderer → main | 保存文件，必要时弹出保存对话框。 |
| `perform-search` | `ipcMain.handle` | renderer → main | 遍历 `tabStore`，返回匹配结果。 |
| `sync-tab-state` | `ipcMain.on` | renderer → main | 渲染端同步标签状态到主进程缓存。 |
| `remove-tab-state` | `ipcMain.on` | renderer → main | 删除关闭标签的缓存。 |
| `display-search-results` | `ipcMain.on` | renderer → main | 搜索窗口发送结果，主进程再广播到主窗口。 |
| `navigate-to-file-line` | `ipcMain.on` | renderer → main | 请求某标签跳转到指定行列。 |
| `open-search-window` | `ipcMain.on` | renderer → main | 主窗口主动请求唤起搜索窗口。 |

主进程向渲染进程广播的事件：

- `menu:new-file`, `menu:open-file`, `menu:save-file`, `menu:save-file-as`, `menu:close-tab`
- `search:results`（搜索结果标签数据）
- `search:navigate`（导航至指定标签与行列）

## 4. 预加载脚本 (`src/preload/index.ts`)

- 使用 `contextBridge` 在隔离上下文下暴露 API，退化模式下直接挂载到 `window`。
- `electronAPI` 扩展：`window.electron` 继承官方 API，并新增 `path.basename`。
- 封装：
  - `invoke(channel, payload?)`：Promise 化 `ipcRenderer.invoke`。
  - `subscribe(channel, listener)`：注册事件监听并返回解除函数。
- `window.api` 提供的高层方法：
  - 文件流程：`openFileDialog()`, `saveFileDialog(payload)`
  - 搜索流程：`performSearch(payload)`, `emitSearchResults(results)`, `emitNavigateToLine(payload)`, `openSearchWindow()`
  - 状态同步：`syncTabState(tab)`, `removeTabState(tabId)`
  - 菜单/搜索事件：`onMenuNewFile`, `onMenuOpenFile`, `onMenuSaveFile`, `onMenuSaveFileAs`, `onMenuCloseTab`, `onSearchResults`, `onSearchNavigate`

## 5. 渲染进程 React 应用

### 5.1 入口与全局样式

- `index.html`：声明 `Content-Security-Policy`，加载 `/src/main.tsx`。
- `main.tsx`：`createRoot` + `StrictMode` 渲染 `App`。
- `App.tsx`：提供全屏容器与背景色，挂载 `TabManager`。
- `index.css`：引入 Tailwind 原子，同时设置 body 及 `#root` 尺寸、字体（JetBrains Mono 系列）、背景及定制滚动条 (`editor-scrollbar`)。

### 5.2 核心组件 `TabManager.tsx`

`TabManager` 负责标签管理、文件读写、搜索结果展示与行高亮：

- **标签模型**：`FileTab`, `SearchTab`, `WelcomeTab`；常量 `SEARCH_TAB_ID`, `WELCOME_TAB_ID`。
- **引用管理**：`tabsRef` / `activeTabIdRef` / `editorRefs` / `highlightRefs` / `highlightInfoRef` / `highlightTimeoutRef` 保持跨事件的最新状态。
- **新建文件**：`createNewTab()` 使用 `crypto.randomUUID()` 生成 tab id，以“Untitled n”命名。
- **打开文件**：`openFiles()` 调用 `api.openFileDialog()`。若文件已在标签中，刷新内容并激活；否则新建标签，标题使用 `window.electron.path.basename`。
- **保存文件**：`handleSave(forceSaveAs)` 构造 `SaveFilePayload`，调用 `api.saveFileDialog()`，成功后更新 `filePath`、标题与脏标记。
- **内容编辑**：`updateTabContent()` 在 textarea `onChange` 时更新内容并设置 `isDirty = true`。
- **标签切换/关闭**：`switchTab()`, `closeTab()`，当所有标签关闭时恢复欢迎页。关闭文件标签会触发 `api.removeTabState`。
- **菜单监听**：`useEffect` 注册来自预加载 API 的菜单回调与搜索事件，组件卸载时统一解绑。
- **搜索结果**：`api.onSearchResults()` 创建/更新搜索标签，标题包含匹配总数；`handleSearchResultSelect()` 点击结果后激活目标标签并调用 `focusLine()`。
- **行高亮**：`focusLine(tabId, line, column)` 计算目标字符索引，设置 `selectionRange`，调整 `scrollTop`，并使用 overlay `div` 在 2 秒内淡出黄色高亮。`useEffect` 监听 textarea 滚动同步 overlay 位置。
- **欢迎页文案**：指导用户通过 File 菜单创建或打开日志，提示可使用 Search 菜单。

### 5.3 搜索窗口

- `search.html`：定义表单，包含文本输入、正则/大小写复选框、提交按钮以及状态提示。
- `search.css`：提供轻量级样式（系统字体、按钮渐变、输入框焦点态等）。
- `search.ts`：
  - 绑定 `submit` 事件，截获默认行为。
  - 构造 `SearchRequest` 并调用 `window.api.performSearch()`。
  - 将结果通过 `window.api.emitSearchResults()` 发回主进程。
  - 根据匹配数量更新状态提示文本，失败时显示错误信息。
  - 初始聚焦搜索输入框。

### 5.4 类型系统 (`env.d.ts`)

定义渲染端共享类型：

- 搜索相关：`SearchMatch`, `SearchResultItem`, `SearchRequest`
- 文件保存：`SaveFilePayload`, `SaveFileResult`
- 标签同步：`SearchableTab`
- API 接口：`LogEditorApi`，声明全部方法与事件监听器；并扩展全局 `Window` 类型以获取类型推断。

## 6. 样式与资源

- Tailwind 提供布局和排版原子类，主要用于 `TabManager` 组件。
- 文本编辑区使用等宽字体与自定义滚动条（浅蓝色滑块、圆角轨道）。
- 搜索窗口采用独立的 `Inter` 系列字体与线性渐变按钮，保持与主界面的视觉协调。
- 静态资源位于 `src/renderer/src/assets/`，当前 UI 未直接引用，但可用于扩展品牌元素。

## 7. 运行流程概述

1. **启动**：主进程创建主窗口并加载 React 应用；预加载脚本将 `window.api` 暴露给渲染端。
2. **文件管理**：菜单事件（`menu:*`）触发 `TabManager` 对应回调，调用 `openFileDialog`/`saveFileDialog`。主进程通过对话框读写文件并返回结果，渲染端更新标签内容及脏标记，同时同步状态到 `tabStore`。
3. **搜索流程**：
   - 用户通过菜单或渲染端逻辑调用 `api.openSearchWindow()` 打开搜索窗口。
   - 搜索窗口提交请求 → 主进程 `perform-search` 遍历缓存标签 → 将 `search:results` 广播给主窗口。
   - 主窗口渲染搜索标签，点击单条结果时发送 `navigate-to-file-line` → 主进程广播 `search:navigate` → `TabManager` 聚焦并高亮目标行。
4. **状态同步**：渲染端每次标签内容变化都会调用 `api.syncTabState()`，确保主进程持有最新文本快照，供搜索与保存使用。

## 8. 复现要点

使用 LLM 复刻该应用时须保证：

- **electron-vite 多入口**：配置 main / preload / renderer，renderer 需包含 `index.html` 与 `search.html` 双入口。
- **预加载接口一致**：实现与本文描述相同的 `LogEditorApi` 与 全局类型声明。
- **TabManager 行为**：再现三类标签、脏标记、双击标签栏空白新建、搜索结果标签、高亮定位与滚动逻辑。
- **主进程 IPC 契约**：实现表格中列出的通道及菜单广播，维持 `tabStore` 缓存以支持跨窗口搜索。
- **样式与 UX**：复现 Tailwind 布局、自定义滚动条与搜索窗口视觉风格。

掌握以上架构、模块职责与接口协议即可据此重建完整的 LogEditor 应用。
