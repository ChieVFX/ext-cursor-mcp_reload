# Cursor Reload MCPs

Small Cursor extension that auto-registers one MCP server, `reload-mcps`, with one tool:

```text
cursor-reload-mcps
```

Use it when MCP tool lists get stale after editing an MCP server.

## What It Does

- Registers the `reload-mcps` MCP server on Cursor startup.
- Provides one MCP tool, also named `cursor-reload-mcps`.
- Reloads servers from `~/.cursor/mcp.json` and `<workspace>/.cursor/mcp.json`.
- Reloads extension-registered servers found in the current workspace's Cursor MCP metadata via Cursor internal refresh commands.
- Accepts project-prefixed Cursor display names such as `project-0-some-project-some-mcp-by-someone` when they end with the configured server name.
- Accepts Cursor display names with or without repeated `extension-` prefixes.
- Skips reloading itself from inside its own MCP tool, because that would kill the stdio response channel.

## Tool Input

```json
{
  "serverName": "optional-server-name",
  "reloadAll": false
}
```

Pass `serverName` to reload one MCP server. Pass `reloadAll: true` to reload every discovered MCP server except `reload-mcps`. Empty `{}` calls are rejected so agents cannot accidentally reload all after a targeted reload fails.

If calling from an agent MCP tool API, use:

- MCP server: the available server whose instructions mention `cursor-reload-mcps` (often displayed as `extension-reload-mcps`; descriptor folders may include `mcp.reload`)
- Resource lookup before a specific reload: `uri:/mcp_lookup/<query>`; replace spaces with `&&`
- Tool name: `cursor-reload-mcps`
- Arguments for all servers: `{ "reloadAll": true }`
- Arguments for one server: `{ "serverName": "my-local-mcp" }`
- Empty arguments: returns a plain-text list of available MCP servers and usage

`serverName` can be an exact name or a unique partial name. If more than one MCP matches, the tool refuses to guess and returns candidates.
For agents, the tool reloads a unique match directly. If the name is ambiguous, no MCP servers are reloaded and candidates are returned.
Available-server lists are scoped to the current workspace plus global Cursor MCP config; stale MCP metadata from other projects is ignored.

Lookup example:

```text
uri:/mcp_lookup/my-local
```

Reload all:

```json
{
  "reloadAll": true
}
```

Target one server:

```json
{
  "serverName": "my-local-mcp"
}
```

If a targeted reload fails, do not retry guessed names and do not call reload-all. Run the tool again with a clearer query or report the returned candidates.

## Install From GitHub Release

Download the latest VSIX from the public GitHub release, then install it in Cursor:

```sh
curl -L -o cursor-reload-mcps.vsix \
  https://github.com/evgeniy-skvortsov/cursor-reload-mcps/releases/latest/download/cursor-reload-mcps.vsix

cursor --install-extension cursor-reload-mcps.vsix
```

You can also run **Extensions: Install from VSIX...** in Cursor and select the downloaded file.

If Cursor CLI prints Node deprecation warnings during install, suppress them with:

```sh
NODE_NO_WARNINGS=1 cursor --install-extension cursor-reload-mcps.vsix
```

## Build Locally

```sh
npm install
npm run build
npm run package
npm run install:cursor
```

Then install the generated `.vsix` through Cursor.

## Notes

The extension uses Cursor's runtime MCP API (`vscode.cursor.mcp.registerServer`) and best-effort internal commands (`mcp.toolListChanged`, `mcp.reloadClient`, `mcp.refreshSnapshot`, `mcp.probeAllServers`). These APIs are not documented by Cursor and may change.

For MCP servers declared in `.cursor/mcp.json`, if internal refresh commands do not work, the extension briefly removes and restores the server entry so Cursor restarts the server process.

## License

MIT
