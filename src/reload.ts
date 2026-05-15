import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export const MCP_SERVER_NAME = 'reload-mcps';
export const EXTENSION_VERSION = '0.5.8';
const MCP_JSON_BOUNCE_GAP_MS = 450;

export type ReloadResult = {
  message: string;
  reloaded: string[];
};

type ReloadableMcpServer = {
  name: string;
  server?: vscode.cursor.mcp.ExtMCPServerConfig['server'];
  source: string;
  aliases?: string[];
  identifiers?: string[];
  refreshKind: 'mcp-json' | 'runtime' | 'cursor-metadata';
  configPath?: string;
};

export type QueuedMcpServerCandidate = {
  name?: unknown;
  source?: unknown;
  aliases?: unknown;
  identifiers?: unknown;
  refreshKind?: unknown;
  configPath?: unknown;
  server?: unknown;
};

export function createMcpServerConfig(
  extensionRoot: string,
  workspaceRoot: string | undefined,
  queueDir: string,
): vscode.cursor.mcp.ExtMCPServerConfig {
  return {
    name: MCP_SERVER_NAME,
    server: {
      command: 'node',
      args: [path.join(extensionRoot, 'dist', 'mcp-server.mjs')],
      env: {
        CURSOR_RELOAD_MCPS_QUEUE_DIR: queueDir,
        CURSOR_RELOAD_MCPS_WORKSPACE_ROOT: workspaceRoot ?? '',
      },
    },
  };
}

export async function reloadCursorMcpServers(
  workspaceRoot: string | undefined,
  extensionRoot: string,
  queueDir: string,
  targetName?: string,
  options: { allowSelf: boolean } = { allowSelf: false },
  queuedCandidate?: QueuedMcpServerCandidate,
): Promise<ReloadResult> {
  const api = vscode.cursor?.mcp;
  if (!api?.registerServer || !api.unregisterServer) {
    throw new Error('Cursor runtime MCP API is unavailable in this build.');
  }

  const normalizedTargetName = targetName ? stripExtensionPrefix(targetName) : undefined;
  if (!options.allowSelf && normalizedTargetName === MCP_SERVER_NAME) {
    return {
      reloaded: [],
      message: `Skipped ${MCP_SERVER_NAME}; it cannot reload itself from its own MCP tool because that would kill the response channel.`,
    };
  }

  const servers = discoverReloadableMcpServers(workspaceRoot, extensionRoot, queueDir);
  const queuedServer = normalizeQueuedMcpServerCandidate(queuedCandidate);
  if (queuedServer) {
    const existing = servers.get(queuedServer.name);
    if (existing) {
      existing.identifiers = uniqueStrings([...(existing.identifiers ?? []), ...(queuedServer.identifiers ?? [])]);
      existing.aliases = uniqueStrings([...(existing.aliases ?? []), ...(queuedServer.aliases ?? [])]);
      existing.server = existing.server ?? queuedServer.server;
      existing.configPath = existing.configPath ?? queuedServer.configPath;
    } else {
      servers.set(queuedServer.name, queuedServer);
    }
  }
  const allTargets = targetName
    ? [resolveTargetServer(workspaceRoot, servers, normalizedTargetName ?? targetName)].filter((server): server is ReloadableMcpServer => !!server)
    : [...servers.values()];

  const targets = (targetName || options.allowSelf)
    ? allTargets
    : allTargets.filter(server => stripExtensionPrefix(server.name) !== MCP_SERVER_NAME);
  const skippedSelf = !targetName && !options.allowSelf && allTargets.length !== targets.length;

  if (targets.length === 0) {
    if (skippedSelf) {
      return {
        reloaded: [],
        message: `No other Cursor MCP servers found. Skipped ${MCP_SERVER_NAME} because it cannot reload itself mid-call.`,
      };
    }
    const known = [...servers.keys()].sort();
    throw new Error(targetName
      ? `[cursor-reload-mcps ${EXTENSION_VERSION}] Cursor MCP "${targetName}" was not found in known MCP configs. Known servers: ${known.length ? known.join(', ') : '(none)'}. Retry with a more specific serverName or call {} to list available servers.`
      : `[cursor-reload-mcps ${EXTENSION_VERSION}] No reloadable Cursor MCP servers were found in known MCP configs. Empty reload arguments are not allowed; pass reloadAll=true only when user explicitly asks to reload all MCPs.`);
  }

  const reloaded: string[] = [];
  const failures: string[] = [];
  const bouncedKeys = new Set<string>();

  for (const target of targets) {
    try {
      const internalRefresh = await refreshMcpSnapshotViaCursorCommand(workspaceRoot, target);
      if (internalRefresh) {
        reloaded.push(target.name);
        continue;
      }

      if (target.refreshKind === 'mcp-json' && target.configPath) {
        const bounceKey = `${target.configPath}\0${target.name}`;
        if (!bouncedKeys.has(bounceKey)) {
          bouncedKeys.add(bounceKey);
          await bounceMcpJsonServerEntry(target.configPath, target.name);
        }
        reloaded.push(target.name);
        continue;
      }

      if (!target.server) {
        throw new Error(`No restart fallback is available for metadata-only server "${target.name}".`);
      }

      const registerName = stripExtensionPrefix(target.name);
      const cleanupNames = new Set<string>([
        target.name,
        registerName,
        ...(target.aliases ?? []),
        `extension-${registerName}`,
        `extension-extension-${registerName}`,
      ]);
      for (const name of cleanupNames) {
        try {
          api.unregisterServer(name);
        } catch {
          // Cursor may not have every display-name variant registered.
        }
      }
      api.registerServer({ name: registerName, server: target.server } as vscode.cursor.mcp.ExtMCPServerConfig);
      reloaded.push(registerName);
    } catch (error) {
      failures.push(`${target.name}: ${toErrorMessage(error)}`);
    }
  }

  if (failures.length > 0) {
    const prefix = reloaded.length > 0 ? `Reloaded ${reloaded.join(', ')}; ` : '';
    throw new Error(`${prefix}failed to reload ${failures.join('; ')}`);
  }

  const baseMessage = `Reloaded Cursor MCP ${reloaded.length === 1 ? 'server' : 'servers'}: ${reloaded.join(', ')}.`;
  return {
    reloaded,
    message: skippedSelf
      ? `${baseMessage} Skipped ${MCP_SERVER_NAME} because it cannot reload itself mid-call.`
      : baseMessage,
  };
}

export function unregisterMcpServerVariants(api: typeof vscode.cursor.mcp, serverName = MCP_SERVER_NAME): void {
  const stripped = stripExtensionPrefix(serverName);
  for (const name of [serverName, stripped, `extension-${stripped}`, `extension-extension-${stripped}`]) {
    try {
      api.unregisterServer(name);
    } catch {
      // Best effort cleanup before re-registering.
    }
  }
}

function discoverReloadableMcpServers(
  workspaceRoot: string | undefined,
  extensionRoot: string,
  queueDir: string,
): Map<string, ReloadableMcpServer> {
  const servers = new Map<string, ReloadableMcpServer>();
  const configPaths = [
    path.join(os.homedir(), '.cursor', 'mcp.json'),
    workspaceRoot ? path.join(workspaceRoot, '.cursor', 'mcp.json') : undefined,
  ].filter((configPath): configPath is string => !!configPath);

  for (const configPath of configPaths) {
    for (const server of readMcpConfigServers(configPath)) {
      servers.set(server.name, server);
    }
  }

  for (const metadata of getMcpServerMetadata(workspaceRoot)) {
    const existing = servers.get(metadata.serverName);
    if (existing) {
      existing.identifiers = uniqueStrings([...(existing.identifiers ?? []), metadata.serverIdentifier]);
      existing.aliases = uniqueStrings([
        ...(existing.aliases ?? []),
        metadata.serverIdentifier,
        metadata.serverName,
        stripExtensionPrefix(metadata.serverName),
      ]);
      continue;
    }
    const stripped = stripExtensionPrefix(metadata.serverName);
    servers.set(metadata.serverName, {
      name: metadata.serverName,
      source: 'Cursor MCP metadata',
      refreshKind: 'cursor-metadata',
      identifiers: [metadata.serverIdentifier],
      aliases: [
        metadata.serverIdentifier,
        stripped,
        `extension-${stripped}`,
        `extension-extension-${stripped}`,
      ],
    });
  }

  servers.set(MCP_SERVER_NAME, {
    ...createMcpServerConfig(extensionRoot, workspaceRoot, queueDir),
    source: 'Cursor Reload MCPs extension',
    refreshKind: 'runtime',
    aliases: [
      `extension-${MCP_SERVER_NAME}`,
      `extension-extension-${MCP_SERVER_NAME}`,
      'cursor-reload-mcps',
      'extension-cursor-reload-mcps',
      'extension-extension-cursor-reload-mcps',
    ],
  });

  return servers;
}

function resolveTargetServer(
  workspaceRoot: string | undefined,
  servers: Map<string, ReloadableMcpServer>,
  name: string,
): ReloadableMcpServer | undefined {
  const direct = servers.get(name);
  if (direct) {
    return direct;
  }

  const byRuntimeIdentifier = resolveTargetServerFromRuntimeIdentifier(workspaceRoot, servers, name);
  if (byRuntimeIdentifier) {
    return byRuntimeIdentifier;
  }

  const stripped = stripExtensionPrefix(name);
  const variants = new Set<string>([
    name,
    stripped,
    `extension-${stripped}`,
    `extension-extension-${stripped}`,
  ]);
  for (const variant of variants) {
    const hit = servers.get(variant);
    if (hit) {
      return hit;
    }
  }
  for (const server of servers.values()) {
    if (variants.has(server.name) || variants.has(stripExtensionPrefix(server.name))) {
      return server;
    }
    if (server.aliases?.some(alias => variants.has(alias))) {
      return server;
    }
    if (serverNameHasProjectPrefix(name, server.name)) {
      return server;
    }
  }

  const fuzzy = resolveFuzzyTargetServer([...servers.values()], name);
  if (fuzzy) {
    return fuzzy;
  }

  return undefined;
}

function resolveTargetServerFromRuntimeIdentifier(
  workspaceRoot: string | undefined,
  servers: Map<string, ReloadableMcpServer>,
  identifier: string,
): ReloadableMcpServer | undefined {
  const metadataByName = getMcpServerIdentifiers(workspaceRoot);
  for (const [serverName, identifiers] of metadataByName) {
    if (!identifiers.includes(identifier)) {
      continue;
    }
    const stripped = stripExtensionPrefix(serverName);
    for (const candidate of [serverName, stripped, `extension-${stripped}`, `extension-extension-${stripped}`]) {
      const server = servers.get(candidate);
      if (server) {
        return server;
      }
    }
  }
  return undefined;
}

function resolveTargetServerFromAnyProjectMetadata(name: string): ReloadableMcpServer | undefined {
  const strippedName = stripExtensionPrefix(name);
  const metadataItems = getAllMcpServerMetadata();
  let matched = metadataItems.filter(metadata => {
    const strippedServerName = stripExtensionPrefix(metadata.serverName);
    return name === metadata.serverIdentifier
      || strippedName === metadata.serverIdentifier
      || name === metadata.serverName
      || strippedName === strippedServerName
      || serverNameHasProjectPrefix(name, metadata.serverName);
  });
  if (matched.length === 0) {
    const fuzzyServerNames = resolveFuzzyServerNames(
      uniqueStrings(metadataItems.map(metadata => metadata.serverName)),
      name,
    );
    if (fuzzyServerNames.length > 1) {
      throw new Error(`MCP server name "${name}" is ambiguous. Matching servers: ${fuzzyServerNames.join(', ')}. Retry with a more specific name.`);
    }
    if (fuzzyServerNames.length === 1) {
      matched = metadataItems.filter(metadata => metadata.serverName === fuzzyServerNames[0]);
    }
  }
  if (matched.length === 0) {
    return undefined;
  }

  const serverName = matched[0].serverName;
  const identifiers = uniqueStrings(matched
    .filter(metadata => metadata.serverName === serverName)
    .map(metadata => metadata.serverIdentifier));
  const strippedServerName = stripExtensionPrefix(serverName);

  return {
    name: serverName,
    source: 'Cursor MCP metadata',
    refreshKind: 'cursor-metadata',
    identifiers,
    aliases: uniqueStrings([
      ...identifiers,
      serverName,
      strippedServerName,
      `extension-${strippedServerName}`,
      `extension-extension-${strippedServerName}`,
    ]),
  };
}

function resolveFuzzyTargetServer(servers: ReloadableMcpServer[], name: string): ReloadableMcpServer | undefined {
  const matches = servers
    .map(server => ({ server, score: fuzzyServerScore(server, name) }))
    .filter(match => match.score > 0)
    .sort((a, b) => b.score - a.score);
  if (matches.length === 0) {
    return undefined;
  }

  const bestScore = matches[0].score;
  const best = matches.filter(match => match.score === bestScore);
  const bestNames = uniqueStrings(best.map(match => match.server.name));
  if (bestNames.length > 1) {
    throw new Error(`MCP server name "${name}" is ambiguous. Matching servers: ${bestNames.join(', ')}. Retry with a more specific name.`);
  }
  return best[0].server;
}

function resolveFuzzyServerNames(serverNames: string[], name: string): string[] {
  const matches = serverNames
    .map(serverName => ({ serverName, score: fuzzyStringScore(serverName, name) }))
    .filter(match => match.score > 0)
    .sort((a, b) => b.score - a.score);
  if (matches.length === 0) {
    return [];
  }
  const bestScore = matches[0].score;
  return uniqueStrings(matches
    .filter(match => match.score === bestScore)
    .map(match => match.serverName));
}

function fuzzyServerScore(server: ReloadableMcpServer, name: string): number {
  return Math.max(...serverLabels(server).map(label => fuzzyStringScore(label, name)));
}

function serverLabels(server: ReloadableMcpServer): string[] {
  return uniqueStrings([
    server.name,
    stripExtensionPrefix(server.name),
    ...(server.aliases ?? []),
    ...(server.identifiers ?? []),
  ]);
}

function fuzzyStringScore(label: string, name: string): number {
  const normalizedLabel = normalizeForMatch(label);
  const normalizedName = normalizeForMatch(name);
  if (!normalizedLabel || !normalizedName) {
    return 0;
  }
  if (normalizedLabel === normalizedName) {
    return 100;
  }
  if (normalizedLabel.endsWith(normalizedName)) {
    return 80;
  }
  if (normalizedName.endsWith(normalizedLabel)) {
    return 75;
  }
  if (normalizedLabel.includes(normalizedName)) {
    return 60;
  }
  if (normalizedName.includes(normalizedLabel)) {
    return 55;
  }

  const tokens = matchTokens(name);
  if (tokens.length > 0 && tokens.every(token => normalizedLabel.includes(token))) {
    return 40;
  }
  return 0;
}

async function refreshMcpSnapshotViaCursorCommand(
  workspaceRoot: string | undefined,
  server: ReloadableMcpServer,
): Promise<boolean> {
  const identifiers = resolveCursorMcpIdentifiers(workspaceRoot, server);
  if (identifiers.length === 0) {
    return false;
  }

  let refreshed = false;
  for (const identifier of identifiers) {
    try {
      await vscode.commands.executeCommand('mcp.toolListChanged', { identifier });
      refreshed = true;
    } catch {
      // Internal command shape may change between Cursor builds.
    }
    try {
      await vscode.commands.executeCommand('mcp.reloadClient', { identifier });
      refreshed = true;
    } catch {
      // Best effort.
    }
    try {
      await vscode.commands.executeCommand('mcp.refreshSnapshot', { identifier });
      refreshed = true;
    } catch {
      // Best effort.
    }
  }

  if (refreshed) {
    try {
      await vscode.commands.executeCommand('mcp.probeAllServers');
    } catch {
      // Best effort.
    }
  }
  return refreshed;
}

function resolveCursorMcpIdentifiers(
  workspaceRoot: string | undefined,
  server: ReloadableMcpServer,
): string[] {
  const identifiers = [...(server.identifiers ?? [])];
  const metadataByName = getMcpServerIdentifiers(workspaceRoot);
  const stripped = stripExtensionPrefix(server.name);
  const names = new Set<string>([
    server.name,
    stripped,
    `extension-${stripped}`,
    `extension-extension-${stripped}`,
    ...(server.aliases ?? []),
  ]);

  for (const name of names) {
    for (const identifier of metadataByName.get(name) ?? []) {
      if (!identifiers.includes(identifier)) {
        identifiers.push(identifier);
      }
    }
  }
  return identifiers;
}

function readMcpConfigServers(configPath: string): ReloadableMcpServer[] {
  if (!fs.existsSync(configPath)) {
    return [];
  }
  const raw = fs.readFileSync(configPath, 'utf-8').trim();
  if (!raw) {
    return [];
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isObjectRecord(parsed) || !isObjectRecord(parsed.mcpServers)) {
    return [];
  }

  const servers: ReloadableMcpServer[] = [];
  for (const [name, value] of Object.entries(parsed.mcpServers)) {
    if (!isObjectRecord(value)) {
      continue;
    }
    const server = normalizeMcpServerConfig(name, value, configPath);
    if (server) {
      servers.push(server);
    }
  }
  return servers;
}

function normalizeMcpServerConfig(
  name: string,
  value: Record<string, unknown>,
  source: string,
): ReloadableMcpServer | undefined {
  const nested = isObjectRecord(value.server) ? value.server : value;
  if (typeof nested.command === 'string') {
    return {
      name,
      source,
      refreshKind: 'mcp-json',
      configPath: source,
      server: {
        command: nested.command,
        args: Array.isArray(nested.args) ? nested.args.filter((arg): arg is string => typeof arg === 'string') : [],
        env: normalizeStringRecord(nested.env),
      },
    };
  }

  if (typeof nested.url === 'string') {
    return {
      name,
      source,
      refreshKind: 'mcp-json',
      configPath: source,
      server: {
        url: nested.url,
        headers: normalizeStringRecord(nested.headers),
      },
    };
  }

  return undefined;
}

function normalizeQueuedMcpServerCandidate(value: QueuedMcpServerCandidate | undefined): ReloadableMcpServer | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name) {
    return undefined;
  }
  const refreshKind = value.refreshKind === 'runtime' || value.refreshKind === 'cursor-metadata'
    ? value.refreshKind
    : 'mcp-json';
  const server = normalizeQueuedServerConfig(value.server);
  return {
    name,
    source: typeof value.source === 'string' ? value.source : 'MCP tool resolved candidate',
    refreshKind: server ? refreshKind : 'cursor-metadata',
    configPath: typeof value.configPath === 'string' ? value.configPath : undefined,
    server,
    aliases: Array.isArray(value.aliases) ? value.aliases.filter((item): item is string => typeof item === 'string') : undefined,
    identifiers: Array.isArray(value.identifiers) ? value.identifiers.filter((item): item is string => typeof item === 'string') : undefined,
  };
}

function normalizeQueuedServerConfig(value: unknown): vscode.cursor.mcp.ExtMCPServerConfig['server'] | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }
  if (typeof value.command === 'string') {
    return {
      command: value.command,
      args: Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === 'string') : [],
      env: normalizeStringRecord(value.env),
    };
  }
  if (typeof value.url === 'string') {
    return {
      url: value.url,
      headers: normalizeStringRecord(value.headers),
    };
  }
  return undefined;
}

type McpServerMetadata = {
  serverName: string;
  serverIdentifier: string;
};

async function bounceMcpJsonServerEntry(configPath: string, serverName: string): Promise<void> {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!isObjectRecord(parsed) || !isObjectRecord(parsed.mcpServers)) {
    throw new Error(`${path.basename(configPath)} has no mcpServers object.`);
  }

  const mcpServers = parsed.mcpServers as Record<string, unknown>;
  if (!(serverName in mcpServers)) {
    throw new Error(`Server "${serverName}" not found in ${configPath}.`);
  }

  const backup = mcpServers[serverName];
  delete mcpServers[serverName];
  fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');

  try {
    await delayMs(MCP_JSON_BOUNCE_GAP_MS);
    mcpServers[serverName] = backup;
    fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
  } catch (error) {
    mcpServers[serverName] = backup;
    try {
      fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
    } catch {
      // Best effort restore.
    }
    throw error;
  }
}

function getMcpServerMetadata(workspaceRoot: string | undefined): McpServerMetadata[] {
  if (!workspaceRoot) {
    return [];
  }

  const mcpsDir = path.join(getCursorProjectDir(workspaceRoot), 'mcps');
  const metadata: McpServerMetadata[] = [];
  try {
    for (const entry of fs.readdirSync(mcpsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const item = readMcpServerMetadata(path.join(mcpsDir, entry.name, 'SERVER_METADATA.json'));
      if (item) {
        metadata.push(item);
      }
    }
  } catch {
    // Metadata cache may not exist yet.
  }
  return metadata;
}

function getAllMcpServerMetadata(): McpServerMetadata[] {
  const projectsDir = path.join(os.homedir(), '.cursor', 'projects');
  const metadata: McpServerMetadata[] = [];
  try {
    for (const project of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!project.isDirectory()) {
        continue;
      }
      const mcpsDir = path.join(projectsDir, project.name, 'mcps');
      if (!fs.existsSync(mcpsDir)) {
        continue;
      }
      try {
        for (const entry of fs.readdirSync(mcpsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) {
            continue;
          }
          const item = readMcpServerMetadata(path.join(mcpsDir, entry.name, 'SERVER_METADATA.json'));
          if (item) {
            metadata.push(item);
          }
        }
      } catch {
        // Skip a single bad project cache, not the whole metadata scan.
      }
    }
  } catch {
    // Best effort across Cursor's project cache.
  }
  return dedupeMcpServerMetadata(metadata);
}

function getMcpServerIdentifiers(workspaceRoot: string | undefined): Map<string, string[]> {
  const metadataByName = new Map<string, string[]>();
  for (const item of getMcpServerMetadata(workspaceRoot)) {
    const current = metadataByName.get(item.serverName) ?? [];
    if (!current.includes(item.serverIdentifier)) {
      current.push(item.serverIdentifier);
    }
    metadataByName.set(item.serverName, current);
  }
  return metadataByName;
}

function readMcpServerMetadata(metadataPath: string): McpServerMetadata | undefined {
  if (!fs.existsSync(metadataPath)) {
    return undefined;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as {
      serverIdentifier?: unknown;
      serverName?: unknown;
    };
    const serverIdentifier = typeof raw.serverIdentifier === 'string' ? raw.serverIdentifier.trim() : '';
    const serverName = typeof raw.serverName === 'string' ? raw.serverName.trim() : '';
    return serverName && serverIdentifier ? { serverName, serverIdentifier } : undefined;
  } catch {
    return undefined;
  }
}

function getCursorProjectDir(workspaceRoot: string): string {
  const slug = workspaceRoot
    .replace(/^\//, '')
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-$/, '');
  return path.join(os.homedir(), '.cursor', 'projects', slug);
}

function stripExtensionPrefix(name: string): string {
  let stripped = name.trim();
  while (stripped.startsWith('extension-')) {
    stripped = stripped.slice('extension-'.length);
  }
  return stripped;
}

function serverNameHasProjectPrefix(candidate: string, serverName: string): boolean {
  const strippedCandidate = stripExtensionPrefix(candidate);
  const strippedServerName = stripExtensionPrefix(serverName);
  return strippedCandidate.endsWith(`-${strippedServerName}`);
}

function normalizeForMatch(value: string): string {
  return stripExtensionPrefix(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function matchTokens(value: string): string[] {
  return stripExtensionPrefix(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !['mcp', 'server', 'cursor', 'extension', 'project'].includes(token));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim()))];
}

function dedupeMcpServerMetadata(items: McpServerMetadata[]): McpServerMetadata[] {
  const seen = new Set<string>();
  const deduped: McpServerMetadata[] = [];
  for (const item of items) {
    const key = `${item.serverName}\0${item.serverIdentifier}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isObjectRecord(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      result[key] = item;
    }
  }
  return result;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function delayMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
