# Go Smart Navigate

**Cmd+click that understands interfaces.** When you cmd+click (or ctrl+click) a Go interface method, VS Code normally jumps to the interface definition - a dead end. This extension makes cmd+click show the interface definition *and* all concrete implementations, so you land where the real code lives.

For concrete types and functions, everything works exactly as before - no extra friction.

## Features

- **Cmd+click on interface methods** opens VS Code's peek widget with the definition alongside all implementations
- **F12 on interface methods** opens a quick pick showing definition, implementations, and usages
- **Usages included** - when you're on a definition, F12 also shows where it's called
- **Zero config** - works out of the box with gopls, stays out of the way for non-interface symbols
- Filters out `vendor/` and `*.pb.go` noise automatically

## How It Works

| Action | On interface method | On concrete symbol |
|--------|--------------------|--------------------|
| **Cmd+click** / **Ctrl+click** | Peek with definition + implementations | Normal go-to-definition (unchanged) |
| **F12** | Quick pick with definition, implementations, and usages | Direct jump to definition (unchanged) |
| **Cmd+F12** / **Ctrl+F12** | Same as F12 | Same as F12 |

## Installation

### Option 1: Install from Marketplace

- [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=devslovecoffee.go-smart-navigate)
- [Open VSX Registry](https://open-vsx.org/extension/devslovecoffee/go-smart-navigate)

### Option 2: Build and Install Locally

**Prerequisites:** [Node.js](https://nodejs.org/), [vsce](https://github.com/microsoft/vscode-vsce)

1. Install dependencies:
   ```
   npm i
   ```
2. Build the extension:
   ```
   vsce package
   ```
   A `.vsix` file will be generated in the workspace directory.

3. In VS Code, go to the Extensions tab, click `...`, then **Install from VSIX...** and select the built file.

> **Tip:** You can drag and drop the `.vsix` file onto the Extensions tab to install it.

## Requirements

- [Go extension](https://marketplace.visualstudio.com/items?itemName=golang.go) with gopls running

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `goSmartNavigate.excludePatterns` | `["**/vendor/**", "**/*.pb.go"]` | Glob patterns for files to exclude from implementation results |
| `goSmartNavigate.showUsages` | `true` | Show usage locations when navigating from a definition |

## Disabling

If this extension conflicts with another, disable its keybindings via **Preferences: Open Keyboard Shortcuts** and search for `goSmartNavigate.go`.
