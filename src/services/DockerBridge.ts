import * as vscode from 'vscode';
import Docker from 'dockerode';
import * as os from 'os';

export type ConnectionStatus = 'connecting' | 'connected' | 'offline';

export type ContainerSummary = {
    id: string;
    name: string;
    image: string;
    status: string; // 'running' | 'exited' | 'paused' | 'restarting' | ...
    state: string;
    created: number;
    ports: { privatePort: number; publicPort?: number; type: string }[];
    labels: Record<string, string>;
    isAutoNamed: boolean;
    composeProject?: string;
};

export type ContainerStats = {
    id: string;
    cpuPercent: number;
    memUsageBytes: number;
    memLimitBytes: number;
    netRxBytes: number;
    netTxBytes: number;
};

/**
 * DockerBridge — direct connection to the Docker Engine API via dockerode.
 * No shelling out to the docker CLI. No backend server.
 * Mirrors the CommandBridge pattern from Redis Live's ioredis integration.
 */
export class DockerBridge {
    private client: Docker | null = null;
    private status: ConnectionStatus = 'connecting';
    private onStatusChange?: (status: ConnectionStatus) => void;
    private eventStream: NodeJS.ReadableStream | null = null;
    private onContainerEvent?: (event: any) => void;

    constructor(
        onStatusChange?: (status: ConnectionStatus) => void,
        onContainerEvent?: (event: any) => void
    ) {
        this.onStatusChange = onStatusChange;
        this.onContainerEvent = onContainerEvent;
    }

    /**
     * Connect to Docker. Non-blocking by design — never awaited on extension
     * activation. Uses the platform-default socket unless a remote host is
     * configured in settings.
     */
    async connect(): Promise<void> {
        const config = vscode.workspace.getConfiguration('docker-vitals');
        const remoteHost = config.get<string>('dockerHost', '').trim();

        this.setStatus('connecting');

        try {
            if (remoteHost) {
                // tcp://host:port style remote connection
                const url = new URL(remoteHost.replace('tcp://', 'http://'));
                this.client = new Docker({ host: url.hostname, port: Number(url.port) || 2375 });
            } else if (process.platform === 'win32') {
                this.client = new Docker({ socketPath: '//./pipe/docker_engine' });
            } else {
                this.client = new Docker({ socketPath: '/var/run/docker.sock' });
            }

            // Verify the daemon actually responds before declaring success
            await this.client.ping();

            this.setStatus('connected');
            this.subscribeToEvents();
        } catch (err) {
            this.client = null;
            this.setStatus('offline');
            throw err;
        }
    }

    isConnected(): boolean {
        return this.client !== null && this.status === 'connected';
    }

    getStatus(): ConnectionStatus {
        return this.status;
    }

    private setStatus(status: ConnectionStatus) {
        this.status = status;
        this.onStatusChange?.(status);
    }

    /**
     * Subscribe to the Docker daemon's event stream for push-based updates
     * instead of polling. This is the architectural equivalent of Redis
     * Live's direct-connection advantage over competitors' CLI-shelling.
     */
    private subscribeToEvents() {
        if (!this.client) return;
        this.client.getEvents({ filters: { type: ['container'] } }, (err, stream) => {
            if (err || !stream) return;
            this.eventStream = stream;
            stream.on('data', (chunk: Buffer) => {
                try {
                    const event = JSON.parse(chunk.toString());
                    this.onContainerEvent?.(event);
                } catch {
                    // ignore malformed chunks (can happen on stream boundaries)
                }
            });
            stream.on('error', () => {
                this.setStatus('offline');
            });
        });
    }

    disconnect(): void {
        if (this.eventStream) {
            (this.eventStream as any).destroy?.();
            this.eventStream = null;
        }
        this.client = null;
        this.setStatus('offline');
    }

    /**
     * List all containers (running + stopped) with parsed metadata.
     */
    async listContainers(): Promise<ContainerSummary[]> {
        if (!this.client) throw new Error('Not connected to Docker');

        const containers = await this.client.listContainers({ all: true });

        return containers.map(c => {
            const rawName = (c.Names[0] || '').replace(/^\//, '');
            const composeProject = c.Labels?.['com.docker.compose.project'];

            return {
                id: c.Id,
                name: rawName,
                image: c.Image,
                status: c.Status,
                state: c.State,
                created: c.Created,
                ports: (c.Ports || []).map(p => ({
                    privatePort: p.PrivatePort,
                    publicPort: p.PublicPort,
                    type: p.Type,
                })),
                labels: c.Labels || {},
                isAutoNamed: isDockerGeneratedName(rawName),
                composeProject,
            };
        });
    }

    /**
     * Get a single snapshot of resource stats for one container.
     * (Live streaming stats are wired up in Phase 8.3.)
     */
    async getContainerStats(id: string): Promise<ContainerStats | null> {
        if (!this.client) return null;
        try {
            const container = this.client.getContainer(id);
            const stats: any = await container.stats({ stream: false });

            const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
            const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
            const cpuCount = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
            const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;

            const memUsageBytes = stats.memory_stats.usage ?? 0;
            const memLimitBytes = stats.memory_stats.limit ?? 0;

            let netRx = 0, netTx = 0;
            if (stats.networks) {
                for (const iface of Object.values(stats.networks) as any[]) {
                    netRx += iface.rx_bytes ?? 0;
                    netTx += iface.tx_bytes ?? 0;
                }
            }

            return {
                id,
                cpuPercent: Math.max(0, cpuPercent),
                memUsageBytes,
                memLimitBytes,
                netRxBytes: netRx,
                netTxBytes: netTx,
            };
        } catch {
            return null; // container may have stopped between list and stats call
        }
    }

    async startContainer(id: string): Promise<void> {
        if (!this.client) throw new Error('Not connected');
        await this.client.getContainer(id).start();
    }

    async stopContainer(id: string): Promise<void> {
        if (!this.client) throw new Error('Not connected');
        await this.client.getContainer(id).stop();
    }

    async restartContainer(id: string): Promise<void> {
        if (!this.client) throw new Error('Not connected');
        await this.client.getContainer(id).restart();
    }

    async removeContainer(id: string): Promise<void> {
        if (!this.client) throw new Error('Not connected');
        await this.client.getContainer(id).remove({ force: true });
    }

    async pauseContainer(id: string): Promise<void> {
        if (!this.client) throw new Error('Not connected');
        await this.client.getContainer(id).pause();
    }

    async unpauseContainer(id: string): Promise<void> {
        if (!this.client) throw new Error('Not connected');
        await this.client.getContainer(id).unpause();
    }

    async listImages(): Promise<ImageSummary[]> {
        if (!this.client) throw new Error('Not connected');
        const images: any[] = await this.client.listImages();
        return images.map(img => ({
            id: (img.Id || '').replace(/^sha256:/, '').slice(0, 12),
            tags: img.RepoTags && img.RepoTags.length ? img.RepoTags : ['<none>:<none>'],
            sizeBytes: img.Size || 0,
            created: img.Created || 0,
        }));
    }

    async removeImage(id: string): Promise<void> {
        if (!this.client) throw new Error('Not connected');
        await this.client.getImage(id).remove({ force: true });
    }

    async getDiskUsage(): Promise<{ layersSizeBytes: number; images: number; containers: number; volumes: number }> {
        if (!this.client) return { layersSizeBytes: 0, images: 0, containers: 0, volumes: 0 };
        try {
            const df: any = await (this.client as any).df();
            return {
                layersSizeBytes: df?.LayersSize ?? 0,
                images: df?.Images?.length ?? 0,
                containers: df?.Containers?.length ?? 0,
                volumes: df?.Volumes?.length ?? 0,
            };
        } catch {
            return { layersSizeBytes: 0, images: 0, containers: 0, volumes: 0 };
        }
    }

    async getSystemInfo(): Promise<SystemVitals> {
        if (!this.client) throw new Error('Not connected');
        const info: any = await this.client.info();
        const runtimes = info?.Runtimes ? Object.keys(info.Runtimes) : [];
        return {
            cpuCount: info?.NCPU ?? 0,
            memTotalBytes: info?.MemTotal ?? 0,
            hasNvidiaRuntime: runtimes.some((r: string) => r.toLowerCase().includes('nvidia')),
            runtimes,
            serverVersion: info?.ServerVersion ?? '',
        };
    }

    async getLogsTail(id: string, tail = 100): Promise<{ line: string; isStderr: boolean }[]> {
        if (!this.client) throw new Error('Not connected');
        const container = this.client.getContainer(id);
        const logOpts: any = { stdout: true, stderr: true, tail: String(tail), timestamps: false };
        const stream: any = await container.logs(logOpts);
        const raw: string = await new Promise((resolve, reject) => {
            let out = '';
            stream.on('data', (c: Buffer) => { out += c.toString('utf8'); });
            stream.on('end', () => resolve(out));
            stream.on('error', reject);
        });
        // Strip docker multiplexed header bytes when present
        const lines = raw.split('\n').filter(l => l.length > 0).slice(-tail);
        return lines.map(l => {
            const clean = l.replace(/^[\x00-\x08\x0B\x0C\x0E-\x1F]{8}/, '');
            const isStderr = /^[\x00-\x02]/.test(l) && l.charCodeAt(0) === 2;
            return { line: clean, isStderr };
        });
    }

    startLogFollow(id: string, onLine: (line: string, isStderr: boolean) => void): () => void {
        if (!this.client) throw new Error('Not connected');
        const container = this.client.getContainer(id);
        let stopped = false;
        let streamRef: any = null;
        (container.logs({ stdout: true, stderr: true, tail: '50', follow: true } as any) as any).then((stream: any) => {
            if (stopped) { stream?.destroy?.(); return; }
            streamRef = stream;
            let buf = '';
            stream.on('data', (c: Buffer) => {
                buf += c.toString('utf8');
                const parts = buf.split('\n');
                buf = parts.pop() ?? '';
                for (const p of parts) {
                    if (!p) continue;
                    const clean = p.replace(/^[\x00-\x08\x0B\x0C\x0E-\x1F]{8}/, '');
                    onLine(clean, false);
                }
            });
            stream.on('error', () => {});
        }).catch(() => {});
        return () => { stopped = true; try { streamRef?.destroy?.(); } catch { /* noop */ } };
    }
}

export type ImageSummary = {
    id: string;
    tags: string[];
    sizeBytes: number;
    created: number;
};

export type SystemVitals = {
    cpuCount: number;
    memTotalBytes: number;
    hasNvidiaRuntime: boolean;
    runtimes: string[];
    serverVersion: string;
};

/**
 * Docker's namesgenerator combines an adjective + a famous scientist's
 * surname (e.g. "silly_darwin", "beavers"). This is a lightweight
 * heuristic check: two lowercase words joined by underscore, OR a single
 * word matching the surname list (Docker sometimes drops the adjective
 * when there's a collision). Full wordlist match happens client-side
 * in the webview against the bundled list for the tooltip.
 */
function isDockerGeneratedName(name: string): boolean {
    return /^[a-z]+(_[a-z]+)?[0-9]*$/.test(name) && name.includes('_');
}
