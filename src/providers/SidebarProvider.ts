import * as vscode from 'vscode';
import { DockerBridge } from '../services/DockerBridge';
import { reportContainerCounts } from '../extension';

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'docker-vitals.sidebar';
    public view?: vscode.WebviewView;

    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private diskTimer: ReturnType<typeof setInterval> | null = null;
    private cpuHistory: number[] = [];
    private memHistory: number[] = [];
    private logStop: (() => void) | null = null;
    private lastComposeSnapshot: string[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly dockerBridge: DockerBridge
    ) {}

    async resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media', 'webview-dist')],
        };

        webviewView.webview.html = this._getHtmlContent(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((message) => this._handleMessage(message, webviewView.webview));

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.startPolling();
                this.refreshContainers();
            } else {
                this.stopPolling();
            }
        });

        if (webviewView.visible) {
            this.startPolling();
            this.refreshContainers();
        }
    }

    handleDockerEvent(event: any) {
        // Push-based update from the Docker event stream — refresh immediately
        // rather than waiting for the next poll tick.
        this.view?.webview.postMessage({ type: 'dockerEvent', data: event });
        this.refreshContainers();
    }

    async refreshContainers() {
        if (!this.view || !this.dockerBridge.isConnected()) return;
        try {
            const containers = await this.dockerBridge.listContainers();
            const running = containers.filter(c => c.state === 'running').length;
            const stopped = containers.length - running;
            reportContainerCounts(running, stopped);

            this.view.webview.postMessage({ type: 'containers', data: containers });

            // Fetch stats only for running containers, in parallel
            const runningContainers = containers.filter(c => c.state === 'running');
            const stats = (await Promise.all(
                runningContainers.map(c => this.dockerBridge.getContainerStats(c.id))
            )).filter(Boolean) as any[];
            this.view.webview.postMessage({ type: 'stats', data: stats });

            // Aggregate + history (max 30 points) — the resource-history differentiator
            const totalCpu = stats.reduce((s, x) => s + (x.cpuPercent || 0), 0);
            const totalMem = stats.reduce((s, x) => s + (x.memUsageBytes || 0), 0);
            this.cpuHistory = [...this.cpuHistory, totalCpu].slice(-30);
            this.memHistory = [...this.memHistory, totalMem].slice(-30);
            this.view.webview.postMessage({ type: 'history', data: { cpu: this.cpuHistory, mem: this.memHistory } });
        } catch {
            // Docker may have gone offline mid-refresh; status bar already reflects this
        }
    }

    async refreshImages() {
        if (!this.view || !this.dockerBridge.isConnected()) return;
        try {
            const images = await this.dockerBridge.listImages();
            this.view.webview.postMessage({ type: 'images', data: images });
        } catch (e: any) {
            this.view.webview.postMessage({ type: 'actionError', data: { message: String(e?.message ?? e) } });
        }
    }

    async refreshVitals() {
        if (!this.view || !this.dockerBridge.isConnected()) return;
        try {
            const [disk, sys] = await Promise.all([
                this.dockerBridge.getDiskUsage(),
                this.dockerBridge.getSystemInfo().catch(() => null),
            ]);
            this.view.webview.postMessage({ type: 'vitals', data: { disk, sys } });
        } catch { /* non-fatal */ }
    }

    /** Compose-diff: snapshot container IDs+images; call after compose/Dockerfile save. */
    async triggerComposeDiff(filename: string) {
        if (!this.view || !this.dockerBridge.isConnected()) return;
        try {
            const before = this.lastComposeSnapshot;
            await new Promise(r => setTimeout(r, 1500));
            const containers: any[] = await this.dockerBridge.listContainers();
            const after = containers.map(c => `${c.name}@${c.image}:${c.state}`);
            const short = filename.split(/[\\/]/).pop() || filename;
            if (before.length === 0) { this.lastComposeSnapshot = after; return; }
            const added = after.filter(x => !before.includes(x));
            const removed = before.filter(x => !after.includes(x));
            this.lastComposeSnapshot = after;
            if (added.length || removed.length) {
                this.view.webview.postMessage({
                    type: 'dockerEvent',
                    data: { Action: `compose-diff: +${added.length} -${removed.length} after ${short}`, Actor: { Attributes: { name: short } } },
                });
                this.view.webview.postMessage({ type: 'composeDiff', data: { filename: short, added, removed, timestamp: Date.now() } });
                this.refreshContainers();
            }
        } catch { /* non-fatal */ }
    }

    snapshotComposeBaseline() {
        this.dockerBridge.listContainers().then(cs => {
            this.lastComposeSnapshot = cs.map(c => `${c.name}@${c.image}:${c.state}`);
        }).catch(() => {});
    }

    private startPolling() {
        if (this.pollTimer) return;
        const config = vscode.workspace.getConfiguration('docker-vitals');
        const interval = config.get<number>('pollInterval', 2000);
        this.pollTimer = setInterval(() => this.refreshContainers(), interval);
        if (!this.diskTimer) {
            this.diskTimer = setInterval(() => this.refreshVitals(), 15000);
            this.refreshVitals();
        }
    }

    private stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.diskTimer) {
            clearInterval(this.diskTimer);
            this.diskTimer = null;
        }
        this.stopLogFollow();
    }

    private stopLogFollow() {
        try { this.logStop?.(); } catch { /* noop */ }
        this.logStop = null;
    }

    private async _handleMessage(message: any, webview: vscode.Webview) {
        const run = async (fn: () => Promise<void>) => {
            try { await fn(); this.refreshContainers(); }
            catch (e: any) {
                webview.postMessage({ type: 'actionError', data: { message: String(e?.message ?? e) } });
            }
        };
        switch (message.type) {
            case 'ready':
                this.refreshContainers();
                this.refreshImages();
                this.refreshVitals();
                this.snapshotComposeBaseline();
                break;
            case 'startContainer':
                await run(() => this.dockerBridge.startContainer(message.data.id));
                break;
            case 'stopContainer':
                await run(() => this.dockerBridge.stopContainer(message.data.id));
                break;
            case 'restartContainer':
                await run(() => this.dockerBridge.restartContainer(message.data.id));
                break;
            case 'removeContainer':
                await run(() => this.dockerBridge.removeContainer(message.data.id));
                break;
            case 'pauseContainer':
                await run(() => this.dockerBridge.pauseContainer(message.data.id));
                break;
            case 'unpauseContainer':
                await run(() => this.dockerBridge.unpauseContainer(message.data.id));
                break;
            case 'refreshImages':
                await this.refreshImages();
                break;
            case 'removeImage':
                await run(async () => { await this.dockerBridge.removeImage(message.data.id); await this.refreshImages(); });
                break;
            case 'openLogs': {
                this.stopLogFollow();
                try {
                    const tail = await this.dockerBridge.getLogsTail(message.data.id, 100);
                    webview.postMessage({ type: 'logs', data: { id: message.data.id, lines: tail, follow: true } });
                    this.logStop = this.dockerBridge.startLogFollow(message.data.id, (line) => {
                        this.view?.webview.postMessage({ type: 'logLine', data: { id: message.data.id, line } });
                    });
                } catch (e: any) {
                    webview.postMessage({ type: 'actionError', data: { message: String(e?.message ?? e) } });
                }
                break;
            }
            case 'closeLogs':
                this.stopLogFollow();
                break;
        }
    }

    private _getHtmlContent(webview: vscode.Webview): string {
        const nonce = getNonce();
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'webview-dist', 'webview.js')
        );
        const csp = [
            `default-src 'none'`,
            `script-src 'nonce-${nonce}'`,
            `style-src 'unsafe-inline' ${webview.cspSource}`,
            `img-src 'self' data:`,
            `font-src ${webview.cspSource} data:`,
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>Docker Vitals</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body, #root { width: 100%; height: 100%; overflow: hidden; }
        body { background: var(--vscode-editor-background); }
    </style>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
}
