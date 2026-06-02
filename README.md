# simplemd

simplemd 是一个基于 Tauri、React 和 CodeMirror 的本地 Markdown 编辑器，面向 Windows 桌面使用。

## 功能

- Markdown 编辑、预览和双栏模式切换
- 多页签打开、切换、拖拽排序和右键关闭
- 打开文件夹并展示 Markdown 文件树
- 最近文件、自动保存、主题切换
- 表格、代码高亮、流程图 Mermaid 渲染
- 外部链接打开前确认，并支持选择系统浏览器

## 开发

```powershell
npm install
npm run tauri:dev
```

## 构建

```powershell
npm run tauri:build
```

构建完成后，Windows 安装包会输出到：

```text
src-tauri\target\release\bundle\nsis\
src-tauri\target\release\bundle\msi\
```

可执行文件会输出到：

```text
src-tauri\target\release\simplemd.exe
```

## 安装使用

推荐使用 NSIS 安装包：

```text
simplemd_1.0.0_x64-setup.exe
```

安装完成后可通过桌面快捷方式或开始菜单启动，Windows 任务管理器中的进程名为 `simplemd.exe`。
