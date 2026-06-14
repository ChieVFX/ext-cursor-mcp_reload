# Release Notes

## 0.5.11

Adds project-local file reload requests for external tools.

### What Changed

- Watches `.cursor/reload-mcps.json` in the active workspace by default.
- Consumes the marker after processing so reloads are one-shot.
- Supports reload-all and targeted reload requests.
- Keeps debug result output separate and off by default.

### Settings

- `reload.reloadViaFile`: default `true`; enables `.cursor/reload-mcps.json` processing.
- `reload.debugReloadViaFile`: default `false`; writes `.cursor/reload-mcps.result.json` with success or failure.

### Request File

Reload every discovered MCP server except `reload-mcps`:

```json
{ "reloadAll": true }
```

Reload one MCP server:

```json
{ "serverName": "unity-369f57df" }
```

Empty `.cursor/reload-mcps.json` also means reload all.

### Unity Integration

Unity editor extensions can write `.cursor/reload-mcps.json` into the project. This is safe even when Cursor is closed or the extension is not installed; the file acts as durable intent. When Cursor opens that workspace with Cursor MCP Reload installed and `reload.reloadViaFile` enabled, it processes the request.

### Install

```sh
curl -L -o reload-0.5.11.vsix https://github.com/ChieVFX/ext-cursor-mcp_reload/releases/download/v0.5.11/reload-0.5.11.vsix
cursor --install-extension reload-0.5.11.vsix --force
```

Reload the Cursor window after installing.

### Smoke Test

1. Open target project in Cursor.
2. Create `.cursor/reload-mcps.json` with `{ "reloadAll": true }`.
3. Confirm file is deleted after processing.
4. Enable `reload.debugReloadViaFile`, repeat request, and confirm `.cursor/reload-mcps.result.json` is written.
