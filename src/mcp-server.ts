import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import mcpInstructions from './mcp-instructions.md';

const TOOL_NAME = 'cursor-reload-mcps';
const SERVER_NAME = 'reload-mcps';
const QUEUE_ACTION = 'reload-cursor-mcps';
const DEFAULT_TIMEOUT_MS = 30_000;
const EXTENSION_VERSION = '0.5.8';

const queueDir = process.env.CURSOR_RELOAD_MCPS_QUEUE_DIR || path.join(os.tmpdir(), 'cursor-reload-mcps');
const requestTimeoutMs = readPositiveInt(process.env.CURSOR_RELOAD_MCPS_REQUEST_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;

const server = new McpServer(
  {
    name: SERVER_NAME,
    version: EXTENSION_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: mcpInstructions,
  },
);

server.registerTool(
  TOOL_NAME,
  {
    title: 'Reload Cursor MCPs',
    description: mcpInstructions,
    inputSchema: {
      serverName: z.string().optional().describe('Optional name or unique partial name of one MCP server to reload.'),
      reloadAll: z.boolean().optional().describe('Optional. Set true to reload every discovered MCP server except reload-mcps.'),
    },
  },
  async ({ serverName, reloadAll }) => {
    const target = typeof serverName === 'string' && serverName.trim() ? serverName.trim() : undefined;
    return resolveThenReload(target, reloadAll === true);
  },
);

void main();

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

async function resolveThenReload(
  serverName: string | undefined,
  reloadAll: boolean,
) {
  try {
    if (serverName && reloadAll) {
      return errorResult('Pass either serverName or reloadAll=true, not both.');
    }
    if (!serverName && !reloadAll) {
      return plainTextResult(formatAvailableMcpServers());
    }

    if (reloadAll) {
      return plainTextResult(formatQueueReloadResult(await queueReloadRequest(undefined, true)));
    }

    const lookup = lookupMcpServers(serverName ?? '');
    if (!lookup.exactName) {
      return plainTextResult(formatLookupMiss(serverName ?? '', lookup));
    }

    const result = await queueReloadRequest(lookup.exactName, false);
    return result.ok
      ? plainTextResult(formatQueueReloadResult(result))
      : errorResult(formatQueueReloadResult(result));
  } catch (error) {
    return errorResult(error);
  }
}

type QueueReloadResult = {
  ok: boolean;
  elapsedMs: number;
  action?: string;
  message?: string;
  reloaded?: string[];
  error?: string;
  [key: string]: unknown;
};

async function queueReloadRequest(serverName: string | undefined, reloadAll: boolean): Promise<QueueReloadResult> {
  const startedAt = Date.now();
  try {
    const requestsDir = path.join(queueDir, 'requests');
    const resultsDir = path.join(queueDir, 'results');
    fs.mkdirSync(requestsDir, { recursive: true });
    fs.mkdirSync(resultsDir, { recursive: true });

    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`;
    const requestPath = path.join(requestsDir, fileName);
    const tempPath = `${requestPath}.${process.pid}.tmp`;
    const record = {
      action: QUEUE_ACTION,
      serverName,
      reloadAll,
      resolvedServer: serverName ? getQueuedCandidate(serverName) : undefined,
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync(tempPath, JSON.stringify(record), 'utf-8');
    fs.renameSync(tempPath, requestPath);

    const result = await waitForResult(path.join(resultsDir, fileName), requestTimeoutMs);
    const elapsedMs = Date.now() - startedAt;
    if (!result) {
      return {
        ok: true,
        queued: true,
        completed: false,
        elapsedMs,
        message: `Cursor MCP reload queued${serverName ? ` for "${serverName}"` : ' for all discovered servers'}, but the extension host did not finish within ${requestTimeoutMs}ms.`,
      };
    }

    try {
      fs.rmSync(path.join(resultsDir, fileName), { force: true });
    } catch {
      // Result cleanup is best effort.
    }

    if (isObjectRecord(result) && result.ok === false) {
      return {
        ok: false,
        elapsedMs,
        error: String(result.error ?? 'Cursor MCP reload failed.'),
      };
    }

    return {
      ok: true,
      elapsedMs,
      ...(isObjectRecord(result) ? result : {}),
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function waitForResult(resultPath: string, timeoutMs: number): Promise<unknown | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(resultPath)) {
      const raw = fs.readFileSync(resultPath, 'utf-8');
      return JSON.parse(raw) as unknown;
    }
    await delayMs(100);
  }
  return undefined;
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function plainTextResult(text: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
  };
}

function errorResult(error: unknown) {
  const message = errorToText(error);
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: message,
      },
    ],
  };
}

function formatAvailableMcpServers(): string {
  const servers = discoverLookupServers()
    .filter(server => server.name !== SERVER_NAME)
    .map(server => server.name);
  if (servers.length === 0) {
    return [
      'No reloadable MCP servers found.',
      'Reload all: {"reloadAll":true}',
    ].join('\n');
  }
  return [
    'Available MCP servers:',
    ...servers.map(name => `- ${name}`),
    '',
    'Reload one: {"serverName":"name-or-unique-part"}',
    'Reload all: {"reloadAll":true}',
  ].join('\n');
}

function formatLookupMiss(query: string, lookup: ReturnType<typeof lookupMcpServers>): string {
  const matches = lookup.matches.map(match => match.name);
  if (lookup.ambiguous && matches.length > 0) {
    return [
      `Ambiguous MCP name "${query}". No servers reloaded.`,
      'Matches:',
      ...matches.map(name => `- ${name}`),
      '',
      'Retry with a more specific serverName.',
    ].join('\n');
  }
  return [
    `No MCP server matched "${query}". No servers reloaded.`,
    '',
    formatAvailableMcpServers(),
  ].join('\n');
}

function formatQueueReloadResult(result: QueueReloadResult): string {
  if (!result.ok) {
    return `Reload failed: ${result.error ?? result.message ?? 'unknown error'}`;
  }
  const reloaded = Array.isArray(result.reloaded)
    ? result.reloaded.filter((item): item is string => typeof item === 'string')
    : [];
  if (reloaded.length > 0) {
    return `Reloaded MCP ${reloaded.length === 1 ? 'server' : 'servers'}: ${reloaded.join(', ')}.`;
  }
  if (typeof result.message === 'string' && result.message.trim()) {
    return result.message;
  }
  return 'MCP reload request completed.';
}

function getQueuedCandidate(serverName: string) {
  const server = discoverLookupServers().find(candidate => candidate.name === serverName);
  if (!server) {
    return undefined;
  }
  return {
    name: server.name,
    source: server.source,
    aliases: server.aliases,
    identifiers: server.identifiers,
    configPath: server.configPath,
    server: server.server,
    refreshKind: server.server ? 'mcp-json' : 'cursor-metadata',
  };
}

function errorToText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (isObjectRecord(error)) {
    if (typeof error.error === 'string') {
      return error.error;
    }
    if (typeof error.message === 'string') {
      return error.message;
    }
  }
  return String(error);
}

function delayMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readPositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

type LookupServer = {
  name: string;
  source: string;
  identifiers: string[];
  aliases: string[];
  configPath?: string;
  server?: {
    command: string;
    args: string[];
    env: Record<string, string>;
  } | {
    url: string;
    headers?: Record<string, string>;
  };
};

function lookupMcpServers(query: string) {
  const servers = discoverLookupServers();
  const matches = servers
    .map(server => ({
      server,
      score: query ? fuzzyServerScore(server, query) : 1,
      matchedLabels: serverLabels(server).filter(label => query ? fuzzyStringScore(label, query) > 0 : label === server.name),
    }))
    .filter(match => match.score > 0)
    .sort((a, b) => b.score - a.score || a.server.name.localeCompare(b.server.name));

  const topScore = matches[0]?.score ?? 0;
  const topMatches = matches.filter(match => match.score === topScore);
  const exactName = topMatches.length === 1 ? topMatches[0].server.name : undefined;

  return {
    query,
    uriQuery: encodeLookupQuery(query),
    exactName,
    ambiguous: topMatches.length > 1,
    matchCount: matches.length,
    matches: matches.slice(0, 25).map(match => ({
      name: match.server.name,
      score: match.score,
      source: match.server.source,
      identifiers: match.server.identifiers,
      aliases: match.server.aliases,
      matchedLabels: match.matchedLabels,
    })),
    usage: exactName
      ? { serverName: exactName }
      : 'No unique exactName. Retry lookup with a more specific query, or choose one name from matches.',
  };
}

function discoverLookupServers(): LookupServer[] {
  const byName = new Map<string, LookupServer>();
  const workspaceRoot = workspaceRootEnv();
  for (const configPath of [
    path.join(os.homedir(), '.cursor', 'mcp.json'),
    workspaceRoot ? path.join(workspaceRoot, '.cursor', 'mcp.json') : undefined,
  ].filter((item): item is string => !!item)) {
    for (const configServer of readMcpConfigServers(configPath)) {
      mergeLookupServer(byName, {
        ...configServer,
        source: configPath,
      });
    }
  }

  for (const metadata of getWorkspaceMcpServerMetadata(workspaceRoot)) {
    mergeLookupServer(byName, {
      name: metadata.serverName,
      source: 'Cursor MCP metadata',
      identifiers: [metadata.serverIdentifier],
      aliases: [metadata.serverIdentifier, stripExtensionPrefix(metadata.serverName)],
    });
  }

  mergeLookupServer(byName, {
    name: SERVER_NAME,
    source: 'Cursor MCP Reload extension',
    identifiers: [],
    aliases: [`extension-${SERVER_NAME}`, TOOL_NAME],
  });

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function mergeLookupServer(byName: Map<string, LookupServer>, next: LookupServer): void {
  const current = byName.get(next.name);
  if (!current) {
    byName.set(next.name, {
      ...next,
      identifiers: uniqueStrings(next.identifiers),
      aliases: uniqueStrings(next.aliases),
    });
    return;
  }
  current.source = current.source === next.source ? current.source : `${current.source}; ${next.source}`;
  current.identifiers = uniqueStrings([...current.identifiers, ...next.identifiers]);
  current.aliases = uniqueStrings([...current.aliases, ...next.aliases]);
  current.configPath = current.configPath ?? next.configPath;
  current.server = current.server ?? next.server;
}

function readMcpConfigServers(configPath: string): LookupServer[] {
  try {
    if (!fs.existsSync(configPath)) {
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
    if (!isObjectRecord(parsed) || !isObjectRecord(parsed.mcpServers)) {
      return [];
    }
    return Object.entries(parsed.mcpServers)
      .map(([name, value]) => normalizeMcpConfigServer(name, value, configPath))
      .filter((server): server is LookupServer => !!server);
  } catch {
    return [];
  }
}

function normalizeMcpConfigServer(name: string, value: unknown, configPath: string): LookupServer | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }
  const nested = isObjectRecord(value.server) ? value.server : value;
  if (typeof nested.command === 'string') {
    return {
      name,
      source: configPath,
      configPath,
      identifiers: [],
      aliases: [],
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
      source: configPath,
      configPath,
      identifiers: [],
      aliases: [],
      server: {
        url: nested.url,
        headers: normalizeStringRecord(nested.headers),
      },
    };
  }
  return {
    name,
    source: configPath,
    configPath,
    identifiers: [],
    aliases: [],
  };
}

type McpServerMetadata = {
  serverName: string;
  serverIdentifier: string;
};

function getWorkspaceMcpServerMetadata(workspaceRoot: string | undefined): McpServerMetadata[] {
  if (!workspaceRoot) {
    return [];
  }
  const mcpsDir = path.join(getCursorProjectDir(workspaceRoot), 'mcps');
  const metadata: McpServerMetadata[] = [];
  try {
    if (!fs.existsSync(mcpsDir)) {
      return [];
    }
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
    // Cursor metadata cache may not exist yet or may be partially written.
  }
  return dedupeMcpServerMetadata(metadata);
}

function readMcpServerMetadata(metadataPath: string): McpServerMetadata | undefined {
  try {
    if (!fs.existsSync(metadataPath)) {
      return undefined;
    }
    const parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as {
      serverIdentifier?: unknown;
      serverName?: unknown;
    };
    const serverIdentifier = typeof parsed.serverIdentifier === 'string' ? parsed.serverIdentifier.trim() : '';
    const serverName = typeof parsed.serverName === 'string' ? parsed.serverName.trim() : '';
    return serverName && serverIdentifier ? { serverName, serverIdentifier } : undefined;
  } catch {
    return undefined;
  }
}

function fuzzyServerScore(server: LookupServer, query: string): number {
  return Math.max(...serverLabels(server).map(label => fuzzyStringScore(label, query)));
}

function serverLabels(server: LookupServer): string[] {
  return uniqueStrings([
    server.name,
    stripExtensionPrefix(server.name),
    ...server.identifiers,
    ...server.aliases,
  ]);
}

function fuzzyStringScore(label: string, query: string): number {
  const normalizedLabel = normalizeForMatch(label);
  const normalizedQuery = normalizeForMatch(query);
  if (!normalizedLabel || !normalizedQuery) {
    return 0;
  }
  if (wildcardPattern(query)) {
    return wildcardPattern(query)?.test(label.toLowerCase()) || wildcardPattern(query)?.test(normalizedLabel) ? 90 : 0;
  }
  if (normalizedLabel === normalizedQuery) {
    return 100;
  }
  if (normalizedLabel.endsWith(normalizedQuery)) {
    return 80;
  }
  if (normalizedLabel.includes(normalizedQuery)) {
    return 60;
  }
  const tokens = matchTokens(query);
  if (tokens.length > 0 && tokens.every(token => normalizedLabel.includes(token))) {
    return 40;
  }
  return 0;
}

function wildcardPattern(query: string): RegExp | undefined {
  if (!query.includes('*') && !query.includes('?')) {
    return undefined;
  }
  const escaped = query
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function normalizeForMatch(value: string): string {
  return stripExtensionPrefix(value)
    .toLowerCase()
    .replace(/[^a-z0-9*?]+/g, '');
}

function matchTokens(value: string): string[] {
  return stripExtensionPrefix(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !['mcp', 'server', 'cursor', 'extension', 'project'].includes(token));
}

function stripExtensionPrefix(name: string): string {
  let stripped = name.trim();
  while (stripped.startsWith('extension-')) {
    stripped = stripped.slice('extension-'.length);
  }
  return stripped;
}

function getCursorProjectDir(workspaceRoot: string): string {
  const slug = workspaceRoot
    .replace(/^\//, '')
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-$/, '');
  return path.join(os.homedir(), '.cursor', 'projects', slug);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
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

function encodeLookupQuery(value: string): string {
  return encodeURIComponent(value.trim().replace(/\s+/g, '&&'));
}

function workspaceRootEnv(): string | undefined {
  const root = process.env.CURSOR_RELOAD_MCPS_WORKSPACE_ROOT?.trim();
  return root || undefined;
}
