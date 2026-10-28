import * as vscode from 'vscode';
import { SidebarProvider } from './providers/SidebarProvider';
import { DockerBridge, ConnectionStatus } from './services/DockerBridge';

let statusBarItem: vscode.StatusBarItem;
let dockerBridge: DockerBridge | null = null;
let sidebarProvider: SidebarProvider | null = null;
let lastRunningCount = 0;
let lastStoppedCount = 0;
let statusBarFlashTimer: ReturnType<typeof setTimeout> | null = null;

export async function activate(context: vscode.ExtensionContext) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'docker-vitals.openPanel';
    statusBarItem.text = '$(circle-outline) Docker Vitals — connecting…';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    dockerBridge = new DockerBridge(
        (status) => updateStatusBar(status),
        (event) => sidebarProvider?.handleDockerEvent(event)
    );

    sidebarProvider = new SidebarProvider(context.extensionUri, dockerBridge);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('docker-vitals.sidebar', sidebarProvider)
    );

    // CRITICAL: never await this on activation. A slow or unreachable Docker
    // daemon must not block extension host startup (this exact mistake cost
    // hours of debugging on Redis Live's ioredis integration).
    dockerBridge.connect().catch(() => {
        // connect() already calls updateStatusBar('offline') internally
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('docker-vitals.openPanel', () => {
            vscode.commands.executeCommand('workbench.view.extension.docker-vitals');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('docker-vitals.reconnect', () => {
            dockerBridge?.connect().then(() => {
                sidebarProvider?.refreshContainers();
            }).catch(() => {
                vscode.window.showWarningMessage('Docker Vitals: still unable to reach Docker. Is Docker Desktop running?');
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('docker-vitals.setHost', async () => {
            const config = vscode.workspace.getConfiguration('docker-vitals');
            const current = config.get<string>('dockerHost', '');
            const input = await vscode.window.showInputBox({
                prompt: 'Docker host (empty = local socket, or tcp://host:2375)',
                value: current,
                placeHolder: 'tcp://192.168.1.10:2375',
            });
            if (input === undefined) return;
            await config.update('dockerHost', input.trim(), vscode.ConfigurationTarget.Global);
            dockerBridge?.disconnect();
            dockerBridge?.connect().then(() => sidebarProvider?.refreshContainers()).catch(() => {
                vscode.window.showWarningMessage('Docker Vitals: cannot reach that host. Check DOCKER_HOST / firewall.');
            });
        })
    );

    // Compose-diff (Redis Live save-diff equivalent): snapshot after compose/Dockerfile saves
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(doc => {
            const name = doc.fileName.split(/[\\/]/).pop() || '';
            if (/^docker-compose.*\.ya?ml$|compose.*\.ya?ml$|^Dockerfile/i.test(name)) {
                sidebarProvider?.triggerComposeDiff(doc.fileName);
            }
        })
    );
}

function updateStatusBar(status: ConnectionStatus) {
    switch (status) {
        case 'connecting':
            statusBarItem.text = '$(circle-outline) Docker Vitals — connecting…';
            statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
            statusBarItem.backgroundColor = undefined;
            vscode.commands.executeCommand('setContext', 'docker-vitals:connected', false);
            break;

        case 'connected':
            statusBarItem.text = `$(circle-filled) ${lastRunningCount} running — ${lastStoppedCount} stopped`;
            statusBarItem.color = undefined;
            statusBarItem.backgroundColor = undefined;
            vscode.commands.executeCommand('setContext', 'docker-vitals:connected', true);
            break;

        case 'offline':
            statusBarItem.text = '$(circle-slash) Docker Vitals — offline';
            statusBarItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            vscode.commands.executeCommand('setContext', 'docker-vitals:connected', false);
            break;
    }
}

/**
 * Called by SidebarProvider whenever the container list refreshes, so the
 * status bar counts stay in sync with what's shown in the sidebar.
 */
export function reportContainerCounts(running: number, stopped: number) {
    const changed = running !== lastRunningCount || stopped !== lastStoppedCount;
    lastRunningCount = running;
    lastStoppedCount = stopped;

    if (dockerBridge?.getStatus() === 'connected') {
        statusBarItem.text = `$(circle-filled) ${running} running — ${stopped} stopped`;
        if (changed) {
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            if (statusBarFlashTimer) clearTimeout(statusBarFlashTimer);
            statusBarFlashTimer = setTimeout(() => {
                statusBarItem.backgroundColor = undefined;
            }, 800);
        }
    }
}

export function deactivate() {
    dockerBridge?.disconnect();
}
