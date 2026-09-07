import * as vscode from 'vscode';
import { DockerBridge } from '../services/DockerBridge';
import { reportContainerCounts } from '../extension';

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'docker-vitals.sidebar';
    public view?: vscode.WebviewView;

    private pollTimer: ReturnType<typeof setInterval> | null = null;

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
            const stats = await Promise.all(
                runningContainers.map(c => this.dockerBridge.getContainerStats(c.id))
            );
            this.view.webview.postMessage({ type: 'stats', data: stats.filter(Boolean) });
        } catch {
            // Docker may have gone offline mid-refresh; status bar already reflects this
        }
    }

    private startPolling() {
        if (this.pollTimer) return;
        const config = vscode.workspace.getConfiguration('docker-vitals');
        const interval = config.get<number>('pollInterval', 2000);
        this.pollTimer = setInterval(() => this.refreshContainers(), interval);
    }

    private stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    private async _handleMessage(message: any, webview: vscode.Webview) {
        switch (message.type) {
            case 'ready':
                this.refreshContainers();
                break;
            case 'startContainer':
                await this.dockerBridge.startContainer(message.data.id);
                this.refreshContainers();
                break;
            case 'stopContainer':
                await this.dockerBridge.stopContainer(message.data.id);
                this.refreshContainers();
                break;
            case 'restartContainer':
                await this.dockerBridge.restartContainer(message.data.id);
                this.refreshContainers();
                break;
            case 'removeContainer':
                await this.dockerBridge.removeContainer(message.data.id);
                this.refreshContainers();
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
