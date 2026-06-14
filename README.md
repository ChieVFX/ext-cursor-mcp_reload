# Cursor MCP Reload

Small Cursor extension that auto-registers one MCP server, `reload-mcps`, with one tool, `cursor-reload-mcps`.

Use it when Cursor MCP tool lists are stale after editing or restarting MCP servers.

## Behavior

- `{}` lists available MCP servers and reloads nothing.
- `{ "serverName": "name-or-unique-part" }` reloads one unique match.
- `{ "reloadAll": true }` reloads all discovered servers except `reload-mcps`.
- For "reload only ..." requests, call `serverName` directly; `{}` is list-only.
- Ambiguous or missing `serverName` reloads nothing and returns plain-text candidates/available servers.
- Scope is global `~/.cursor/mcp.json`, current workspace `.cursor/mcp.json`, and current workspace Cursor MCP metadata.
- Stale MCPs from other projects are ignored.
- Output is plain text, not JSON.
- No resources, prompts, or elicitation are exposed.

## File Reload

Enabled by default: `reload.reloadViaFile`.

The extension watches the current workspace for `.cursor/reload-mcps.json`. Creating that file triggers a reload and consumes the file. This is intended for external tools such as Unity editor extensions: they can write the marker without requiring Cursor, this extension, or the MCP server to be running. If Cursor opens the project later, the marker is picked up on extension activation.

Request examples:

```json
{ "reloadAll": true }
```

```json
{ "serverName": "unity-369f57df" }
```

Empty file means `{ "reloadAll": true }`. Passing both `serverName` and `reloadAll` is rejected. Passing `{ "reloadAll": false }` without `serverName` is rejected.

Optional debug output, default off: enable `reload.debugReloadViaFile` to write `.cursor/reload-mcps.result.json` for both success and failure.

Debug result shape:

```json
{
  "ok": true,
  "action": "reload-cursor-mcps",
  "processedAt": "2026-06-14T15:00:00.000Z",
  "elapsedMs": 123,
  "message": "Reloaded Cursor MCP server: unity-369f57df.",
  "reloaded": ["unity-369f57df"]
}
```

Failure result uses `"ok": false` and an `"error"` string.

## Install

```sh
curl -L -o reload-0.5.11.vsix https://github.com/ChieVFX/ext-cursor-mcp_reload/releases/download/v0.5.11/reload-0.5.11.vsix
cursor --install-extension reload-0.5.11.vsix --force
```

## Build Locally

```sh
npm install
npm run package
npm run install:cursor
```

Reload the Cursor window after installing so the extension host restarts and re-registers the MCP server.

## Notes

This extension uses Cursor's undocumented runtime MCP API (`vscode.cursor.mcp.registerServer`) plus best-effort internal refresh commands. For `.cursor/mcp.json` servers, it can fall back to briefly removing/restoring the config entry so Cursor restarts that MCP.

License: MIT
