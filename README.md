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

## Install

```sh
curl -L -o reload-0.5.8.vsix https://github.com/ChieVFX/ext-cursor-mcp_reload/releases/download/v0.5.8/reload-0.5.8.vsix
cursor --install-extension reload-0.5.8.vsix --force
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
