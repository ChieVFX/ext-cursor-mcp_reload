Tool call descriptor:
cursor-reload-mcps({
  serverName?: string,
  reloadAll?: boolean
})

Purpose: reload Cursor MCP tool lists after MCP server changes.

Fields:
- serverName: exact or partial MCP server name; reloads one unique match
- reloadAll: true reloads all discovered MCP servers except reload-mcps
- no fields: list available MCP servers; reloads nothing

Examples:
- cursor-reload-mcps({"serverName":"browser"}) -> reload one matching MCP server
- cursor-reload-mcps({"reloadAll":true}) -> reload all MCP servers except reload-mcps
- cursor-reload-mcps({}) -> list available MCP servers
