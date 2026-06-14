import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  MCP_SERVER_NAME,
  createMcpServerConfig,
  reloadCursorMcpServers,
  type QueuedMcpServerCandidate,
  unregisterMcpServerVariants,
} from './reload';

type QueueRequest = {
  id?: unknown;
  action?: unknown;
  serverName?: unknown;
  reloadAll?: unknown;
  resolvedServer?: QueuedMcpServerCandidate;
  createdAt?: unknown;
};

type QueueResult = {
  ok: boolean;
  action: string;
  processedAt: string;
  elapsedMs: number;
  message?: string;
  reloaded?: string[];
  error?: string;
};

type FileReloadRequest = {
  serverName?: unknown;
  reloadAll?: unknown;
};

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Cursor Reload MCPs');
  context.subscriptions.push(output);

  const extensionRoot = context.extensionUri.fsPath;
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const queueDir = path.join(context.globalStorageUri.fsPath, 'queue');
  fs.mkdirSync(queueDir, { recursive: true });

  const processor = new ReloadQueueProcessor({
    queueDir,
    workspaceRoot,
    extensionRoot,
    output,
  });
  context.subscriptions.push(processor);
  context.subscriptions.push(new FileReloadProcessor({
    queueDir,
    workspaceRoot,
    extensionRoot,
    output,
  }));

  const api = vscode.cursor?.mcp;
  if (!api?.registerServer || !api.unregisterServer) {
    output.appendLine('Cursor runtime MCP API is unavailable; MCP server was not registered.');
    void vscode.window.showWarningMessage('Cursor Reload MCPs: Cursor runtime MCP API is unavailable in this build.');
    return;
  }

  const serverConfig = createMcpServerConfig(extensionRoot, workspaceRoot, queueDir);
  unregisterMcpServerVariants(api, MCP_SERVER_NAME);
  api.registerServer(serverConfig);
  output.appendLine(`Registered MCP server "${MCP_SERVER_NAME}".`);

  context.subscriptions.push(new vscode.Disposable(() => {
    unregisterMcpServerVariants(api, MCP_SERVER_NAME);
  }));
}

export function deactivate(): void {
  // Disposables registered during activation handle cleanup.
}

class FileReloadProcessor implements vscode.Disposable {
  private readonly cursorDir: string | undefined;
  private readonly requestPath: string | undefined;
  private readonly resultPath: string | undefined;
  private watcher?: fs.FSWatcher;
  private configDisposable?: vscode.Disposable;
  private debounceHandle?: NodeJS.Timeout;
  private processing = false;
  private pending = false;
  private reloadViaFile = false;

  constructor(private readonly options: {
    queueDir: string;
    workspaceRoot: string | undefined;
    extensionRoot: string;
    output: vscode.OutputChannel;
  }) {
    this.cursorDir = options.workspaceRoot ? path.join(options.workspaceRoot, '.cursor') : undefined;
    this.requestPath = this.cursorDir ? path.join(this.cursorDir, 'reload-mcps.json') : undefined;
    this.resultPath = this.cursorDir ? path.join(this.cursorDir, 'reload-mcps.result.json') : undefined;
    this.reloadViaFile = this.readReloadViaFile();

    this.configureWatcher();
    this.configDisposable = vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('reload.reloadViaFile')) {
        return;
      }
      this.reloadViaFile = this.readReloadViaFile();
      if (this.reloadViaFile) {
        this.scheduleProcess();
      }
    });
    if (this.reloadViaFile) {
      this.scheduleProcess();
    }
  }

  dispose(): void {
    this.watcher?.close();
    this.configDisposable?.dispose();
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
      this.debounceHandle = undefined;
    }
  }

  private readReloadViaFile(): boolean {
    return vscode.workspace.getConfiguration('reload').get<boolean>('reloadViaFile', true);
  }

  private readDebugReloadViaFile(): boolean {
    return vscode.workspace.getConfiguration('reload').get<boolean>('debugReloadViaFile', false);
  }

  private configureWatcher(): void {
    if (!this.cursorDir) {
      return;
    }

    try {
      fs.mkdirSync(this.cursorDir, { recursive: true });
      this.watcher = fs.watch(this.cursorDir, (_event, fileName) => {
        if (fileName === 'reload-mcps.json') {
          this.reloadViaFile = this.readReloadViaFile();
          if (this.reloadViaFile) {
            this.scheduleProcess();
          }
        }
      });
    } catch (error) {
      this.options.output.appendLine(`Failed to watch file reload marker: ${toErrorMessage(error)}`);
    }
  }

  private scheduleProcess(): void {
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
    }
    this.debounceHandle = setTimeout(() => {
      this.debounceHandle = undefined;
      void this.process();
    }, 250);
  }

  private async process(): Promise<void> {
    if (!this.reloadViaFile || !this.requestPath) {
      return;
    }
    if (this.processing) {
      this.pending = true;
      return;
    }
    if (!fs.existsSync(this.requestPath)) {
      return;
    }

    this.processing = true;
    const startedAt = Date.now();
    try {
      const request = this.readRequest(this.requestPath);
      const serverName = typeof request.serverName === 'string' && request.serverName.trim()
        ? request.serverName.trim()
        : undefined;
      const reloadAll = request.reloadAll === true || (!serverName && request.reloadAll !== false);
      if (serverName && reloadAll) {
        throw new Error('Pass either serverName or reloadAll=true, not both.');
      }
      if (!serverName && !reloadAll) {
        throw new Error('Missing serverName. To reload every MCP server, set reloadAll=true or use an empty marker file.');
      }

      this.options.output.appendLine(serverName
        ? `File reload request started for "${serverName}".`
        : 'File reload request started for all discovered MCP servers.');

      const result = await reloadCursorMcpServers(
        this.options.workspaceRoot,
        this.options.extensionRoot,
        this.options.queueDir,
        serverName,
        { allowSelf: false },
      );

      this.writeResult({
        ok: true,
        action: 'reload-cursor-mcps',
        processedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        message: result.message,
        reloaded: result.reloaded,
      });
      this.options.output.appendLine(result.message);
    } catch (error) {
      const message = toErrorMessage(error);
      this.writeResult({
        ok: false,
        action: 'reload-cursor-mcps',
        processedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        error: message,
      });
      this.options.output.appendLine(`File reload request failed: ${message}`);
    } finally {
      fs.rmSync(this.requestPath, { force: true });
      this.processing = false;
      if (this.pending) {
        this.pending = false;
        this.scheduleProcess();
      }
    }
  }

  private readRequest(filePath: string): FileReloadRequest {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) {
      return { reloadAll: true };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isObjectRecord(parsed)) {
      throw new Error('reload-mcps.json must contain a JSON object.');
    }
    return parsed;
  }

  private writeResult(result: QueueResult): void {
    if (!this.resultPath || !this.readDebugReloadViaFile()) {
      return;
    }
    const tempPath = `${this.resultPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
    fs.renameSync(tempPath, this.resultPath);
  }
}

class ReloadQueueProcessor implements vscode.Disposable {
  private readonly requestsDir: string;
  private readonly resultsDir: string;
  private watcher?: fs.FSWatcher;
  private pollHandle?: NodeJS.Timeout;
  private retryHandle?: NodeJS.Timeout;
  private processing = false;
  private pending = false;

  constructor(private readonly options: {
    queueDir: string;
    workspaceRoot: string | undefined;
    extensionRoot: string;
    output: vscode.OutputChannel;
  }) {
    this.requestsDir = path.join(options.queueDir, 'requests');
    this.resultsDir = path.join(options.queueDir, 'results');
    fs.mkdirSync(this.requestsDir, { recursive: true });
    fs.mkdirSync(this.resultsDir, { recursive: true });

    this.watch();
    this.pollHandle = setInterval(() => this.scheduleProcess(), 1_000);
    this.scheduleProcess();
  }

  dispose(): void {
    this.watcher?.close();
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }
    if (this.retryHandle) {
      clearTimeout(this.retryHandle);
      this.retryHandle = undefined;
    }
  }

  private watch(): void {
    try {
      this.watcher = fs.watch(this.requestsDir, () => {
        this.scheduleProcess();
      });
    } catch (error) {
      this.options.output.appendLine(`Failed to watch MCP queue: ${toErrorMessage(error)}`);
    }
  }

  private scheduleProcess(): void {
    if (this.processing) {
      this.pending = true;
      return;
    }
    void this.processPending();
  }

  private async processPending(): Promise<void> {
    if (this.processing) {
      this.pending = true;
      return;
    }
    this.processing = true;
    try {
      let didProcess = false;
      do {
        didProcess = false;
        for (const filePath of this.listRequestFiles()) {
          const handled = await this.processFile(filePath);
          didProcess = handled || didProcess;
        }
      } while (didProcess);
    } finally {
      this.processing = false;
      if (this.pending) {
        this.pending = false;
        this.scheduleProcess();
      }
    }
  }

  private listRequestFiles(): string[] {
    try {
      return fs.readdirSync(this.requestsDir)
        .filter(name => name.endsWith('.json'))
        .sort()
        .map(name => path.join(this.requestsDir, name));
    } catch {
      return [];
    }
  }

  private async processFile(filePath: string): Promise<boolean> {
    const requestFile = path.basename(filePath);
    const startedAt = Date.now();
    const request = this.readRequest(filePath);
    if (!request) {
      this.scheduleRetry();
      return false;
    }

    const action = typeof request.action === 'string' ? request.action : 'unknown';
    try {
      if (action !== 'reload-cursor-mcps') {
        throw new Error(`Unrecognised MCP queue action: ${action}`);
      }

      const serverName = typeof request.serverName === 'string' && request.serverName.trim()
        ? request.serverName.trim()
        : undefined;
      const reloadAll = request.reloadAll === true;
      if (serverName && reloadAll) {
        throw new Error('Pass either serverName or reloadAll=true, not both.');
      }
      if (!serverName && !reloadAll) {
        throw new Error('Missing serverName. To reload every MCP server, pass {"reloadAll":true}. Do not use empty arguments as fallback after a targeted reload fails.');
      }
      this.options.output.appendLine(serverName
        ? `Reload request started for "${serverName}".`
        : 'Reload request started for all discovered MCP servers.');

      const result = await reloadCursorMcpServers(
        this.options.workspaceRoot,
        this.options.extensionRoot,
        this.options.queueDir,
        serverName,
        { allowSelf: false },
        isObjectRecord(request.resolvedServer) ? request.resolvedServer : undefined,
      );

      this.writeResult(requestFile, {
        ok: true,
        action,
        processedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        message: result.message,
        reloaded: result.reloaded,
      });
      this.options.output.appendLine(result.message);
      fs.rmSync(filePath, { force: true });
      return true;
    } catch (error) {
      const message = toErrorMessage(error);
      this.writeResult(requestFile, {
        ok: false,
        action,
        processedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        error: message,
      });
      this.options.output.appendLine(`Reload request failed: ${message}`);
      fs.rmSync(filePath, { force: true });
      return true;
    }
  }

  private readRequest(filePath: string): QueueRequest | undefined {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as QueueRequest;
    } catch {
      return undefined;
    }
  }

  private writeResult(requestFile: string, result: QueueResult): void {
    const resultPath = path.join(this.resultsDir, requestFile);
    const tempPath = `${resultPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(result), 'utf-8');
    fs.renameSync(tempPath, resultPath);
  }

  private scheduleRetry(): void {
    if (this.retryHandle) {
      return;
    }
    this.retryHandle = setTimeout(() => {
      this.retryHandle = undefined;
      this.scheduleProcess();
    }, 250);
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
