# Go Smart Navigate

Unified go-to-definition + go-to-implementations for Go. When you press `F12` on an interface method, instead of jumping only to the interface definition, you get a picker showing both the definition and all implementations.

For concrete types and functions, behavior is identical to the default `F12` — a direct jump with no extra friction.

## Keybindings

| Key | Behavior |
|-----|----------|
| `F12` | Smart navigate (replaces default Go to Definition for Go files) |
| `Cmd+F12` / `Ctrl+F12` | Smart navigate (alternative binding) |

## Requirements

- The [Go extension](https://marketplace.visualstudio.com/items?itemName=golang.go) must be installed and gopls running.

## Cmd+click Support

The extension registers a supplementary definition provider for Go. When you cmd+click an interface method, VSCode's peek widget appears showing the definition (from gopls) alongside all implementations (from this extension). For concrete symbols, the extension stays out of the way — cmd+click behaves exactly as before.

## Known Limitations

- Locations inside `vendor/` directories and `*.pb.go` (protobuf generated) files are filtered out from the implementation list.

## Disabling

If this extension conflicts with another, you can disable its keybindings by opening **Preferences: Open Keyboard Shortcuts** and searching for `goSmartNavigate.go`, then removing the bindings.
