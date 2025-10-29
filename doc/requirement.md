# LogEditor Requirement

本项目是基于Electron 的桌面应用程序。核心目标是提供一个轻量级的日志文件查看于编辑器，并具备跨文件搜索功能。

## 1. 技术栈概览

- **主框架**: [Electron](https://www.electronjs.org/) - 用于构建跨平台桌面应用。
- **构建工具**: [electron-vite](https://github.com/alex8088/electron-vite) - 基于 Vite 的高效 Electron 构建工具，提供快速开发体验。
- **前端框架**: [React](https://react.dev/) (v19) - 用于构建用户界面。
- **样式系统**: [Tailwind CSS](https://tailwindcss.com/) + [PostCSS](https://postcss.org/) - 使用实用优先的 CSS 框架进行样式设计。
- **编程语言**: [TypeScript](https://www.typescriptlang.org/) - 为 JavaScript 提供类型安全。
- **包管理**: npm
- **代码规范**: ESLint + Prettier

## 2. 核心配置文件解析

### 2.1 package.json

package.json 定义了项目基本信息、依赖项和脚本命令。

### 2.2 electron.vite.config.ts

这是项目的构建核心配置，使用 `electon-vite` 进行多进程构建。

## 3. 目录结构与核心源码

项目的源码位于 `src/` 目录下，遵循清晰的职责分离。

```
src/
├── main/              # 主进程代码 (Node.js 环境)
│   └── index.ts       # 主进程入口
├── preload/           # 预加载脚本 (Node.js 环境)
│   ├── index.ts       # 预加载脚本入口
│   └── index.d.ts     # 预加载脚本的类型声明
└── renderer/          # 渲染进程代码 (浏览器环境)
    ├── src/           # React 应用源码
    │   ├── assets/    # 静态资源
    │   ├── components/# React 组件
    │   ├── env.d.ts   # 渲染进程全局类型声明
    │   ├── App.css    # 应用级CSS
    │   ├── App.tsx    # 根组件
    │   ├── index.css  # 全局CSS入口
    │   ├── main.tsx   # React 入口
    │   └── search.ts  # 独立搜索窗口的逻辑
    ├── index.html     # 主窗口HTML模板
    └── search.html    # 搜索窗口HTML模板
```

### 3.1 主进程 (`src/main/index.ts`)

这是 Electron 应用的"大脑"，负责创建窗口、处理系统事件和与操作系统交互。

**核心功能**:
1.  **创建主窗口**: 创建一个 `BrowserWindow` 实例，加载 `renderer/index.html`。WebPreferences 中启用了 `contextIsolation` 和 `sandbox: false`，并通过 `preload` 选项链接预加载脚本，这是安全的最佳实践。
2.  **创建菜单**: 使用 `Menu.buildFromTemplate()` 创建了带有 "File", "Edit", "Search" 等标准菜单项的应用菜单。菜单项通过 `ipcMain` 发送消息或直接调用方法。
3.  **创建搜索窗口**: 当用户选择 "Find" 时，会创建一个独立的 `searchWindow`，加载 search.html。
4.  **IPC 通信 (主进程端)**: 使用 `ipcMain.handle` 和 `ipcMain.on` 定义了多个通道，处理来自渲染进程的异步请求和同步事件。
    - `open-file-dialog`: 处理打开文件对话框，返回文件路径和内容。
    - `save-file-dialog`: 处理保存文件对话框，返回文件路径。
    - `perform-search`: 在所有已打开的文件中执行搜索，支持正则表达式。
    - `navigate-to-file-line`: 监听此事件以将搜索结果导航到主窗口的对应标签页和行号。
5.  **状态管理**: 使用 `Map` 对象 `openedFiles` 存储所有已打开文件的路径和内容。

### 3.2 预加载脚本 (`src/preload/index.ts`)

这是连接主进程和渲染进程的安全桥梁，通过 `contextBridge` 将有限的、受控的 API 暴露给渲染进程。

**核心功能**:
1.  **暴露 `window.api`**:
    - 封装了 `ipcRenderer.invoke` 调用，提供 openFileDialog, saveFileDialog, performSearch 等方法。
    - 提供了监听主进程事件的方法，如 onFileNew, onFileSave，并配套提供了移除监听器的方法。
2.  **暴露 `window.electron`**:
    - 提供对原始 `ipcRenderer` 对象的访问，允许更灵活的消息传递。
    - 暴露了 `path.basename` 函数，用于获取文件名。

### 3.3 渲染进程 (React 应用)

#### 3.3.1 入口与基础结构

- **src/renderer/index.html**: 简单的 HTML 模板，包含 CSP 策略，并挂载 React 应用到 `<div id="root">`。
- **src/renderer/src/main.tsx**: React 应用的入口，使用 `ReactDOM.createRoot` 渲染 App 组件。
- **src/renderer/src/App.tsx**: 根组件，非常简洁，只负责渲染 TabManager 组件。

#### 3.3.2 核心 UI 组件 (`src/renderer/src/components/TabManager.tsx`)

这是应用的 UI 核心，实现了标签页式界面。

**核心功能**:
1.  **状态管理**: 使用 `useState` 管理 `tabs` 数组，每个 Tab 对象包含 id, title, content, filePath, isActive 等属性。
2.  **标签页操作**:
    - createOrUpdateTab: 创建新标签或更新现有标签。
    - switchTab: 切换活动标签页。
    - closeTab: 关闭标签页，并处理关闭最后一个标签页时显示欢迎页的情况。
3.  **IPC 通信 (渲染进程端)**:
    - 使用 `useEffect` 注册事件监听器，监听来自主进程的 `file-opened`, `focus-file-line` 等事件。
    - 通过 `window.api` 调用预加载脚本暴露的方法，如 handleNewFile, handleSaveFile。
4.  **高级特性**:
    - **脏标记 (Dirty Flag)**: 当文件内容被修改但未保存时，标签页标题旁会显示一个红点。
    - **行高亮**: 当从搜索结果跳转时，能够滚动到指定行并用黄色背景临时高亮该行。这通过动态创建绝对定位的 `<div>` 元素并监听 `textarea` 的滚动事件来实现。
5.  **搜索结果展示**: 专门的 renderSearchResults 方法，将搜索结果按文件分组，并允许点击结果条目跳转到原文。

#### 3.3.3 独立搜索窗口 (`src/renderer/src/search.html` & src/renderer/src/search.ts`)

这是一个独立的、无边框的窗口，用于输入搜索条件。

- **search.html**: 包含搜索输入框、正则表达式复选框和搜索按钮的简单界面。
- **search.ts**: 处理搜索逻辑。当用户点击搜索后，它调用 `window.api.performSearch` 执行搜索，并将结果通过 `window.electron.ipcRenderer.send('display-search-results')` 发送到主窗口，然后自身不会关闭。

### 3.4 类型声明 (`src/renderer/src/env.d.ts`)

此文件至关重要，它扩展了 Window 接口，为 `window.api` 和 `window.electron` 添加了完整的 TypeScript 类型定义，使得在 React 组件中调用这些 API 时能获得智能提示和类型检查。

## 4. 通信机制总结

该项目的 IPC 通信设计精巧，形成了一个闭环：

1.  **渲染 -> 主**: 用户在 UI 上的操作（如点击"打开文件"）通过 `window.api` -> preload -> `ipcRenderer.invoke` 触发主进程的 `ipcMain.handle` 回调。
2.  **主 -> 渲染**: 主进程完成任务后，有时会直接使用 `BrowserWindow.webContents.send(channel)` 向特定的渲染进程窗口发送事件（如 `file-opened`, `show-search-results`），由渲染进程的 `ipcRenderer.on` 或 `window.api` 监听器接收。
3.  **渲染 <-> 渲染**: 主窗口和搜索窗口之间也存在通信。搜索窗口完成搜索后，将结果发送给主窗口 (`display-search-results`)；主窗口处理完搜索结果后，可能反过来通知搜索窗口（虽然当前代码中未体现）。
