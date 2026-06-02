# simplemd

[English](./README-en.md) | [中文](./README.md)

simplemd is a local Markdown editor based on Tauri, React, and CodeMirror, designed for Windows desktop users.

## Features

- Markdown editing, previewing, and split-pane mode toggling
- Multi-tab support: open, switch, drag to reorder, and right-click to close
- Open folders and display Markdown file tree
- Recent files, auto-save, and theme switching
- Table, code highlighting, and Mermaid flowchart rendering
- Confirmation prompt before opening external links, with support for selecting the system browser

## Development

```powershell
npm install
npm run tauri:dev
```

## Build

```powershell
npm run tauri:build
```

After the build is complete, the Windows installation packages will be output to:

```text
src-tauri\target\release\bundle\nsis\
src-tauri\target\release\bundle\msi\
```

The executable file will be output to:

```text
src-tauri\target\release\simplemd.exe
```

## Installation & Usage

It is recommended to use the NSIS installer:

```text
simplemd_1.0.0_x64-setup.exe
```

After installation, it can be launched via the desktop shortcut or Start menu. The process name in Windows Task Manager is `simplemd.exe`.

## License

This project is licensed under the [ISC License](./LICENSE).
