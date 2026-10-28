import React, { useState, useEffect, useRef } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

type ContainerSummary = {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  created: number;
  ports: { privatePort: number; publicPort?: number; type: string }[];
  labels: Record<string, string>;
  isAutoNamed: boolean;
  composeProject?: string;
};

type ContainerStats = {
  id: string;
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
  netRxBytes: number;
  netTxBytes: number;
};

type ImageSummary = { id: string; tags: string[]; sizeBytes: number; created: number };
type EventLine = { id: string; text: string; timestamp: number };
type LogLine = { line: string; isStderr: boolean };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMem(bytes: number): string {
  if (!bytes) return '0MB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}
function formatBytes(bytes: number): string { return formatMem(bytes); }
function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

const DOCKER_BLUE = '#2496ED';
const STOPPED_GRAY = '#6a6a6a';
const WARN_AMBER = '#dcdcaa';
function stateColor(state: string): string {
  if (state === 'running') return DOCKER_BLUE;
  if (state === 'restarting' || state === 'paused') return WARN_AMBER;
  return STOPPED_GRAY;
}

function Sparkline({ data, color, width = 120, height = 28 }: { data: number[]; color: string; width?: number; height?: number }) {
  if (data.length < 2) return <div style={{ width, height, color: 'var(--vscode-descriptionForeground)', fontSize: 10 }}>collecting…</div>;
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - (v / max) * (height - 2) - 1}`).join(' ');
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

// ─── Container row (double-click expand, ⋯ menu, ▤ logs) ─────────────────────

function ContainerRow({ container, stats, onAction, onOpenLogs }:
  { container: ContainerSummary; stats: ContainerStats | undefined; onAction: (a: string, id: string) => void; onOpenLogs: (id: string, name: string) => void }) {
  const [showTag, setShowTag] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRunning = container.state === 'running';
  const color = stateColor(container.state);

  const handleRemoveClick = () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      confirmTimer.current = setTimeout(() => setConfirmRemove(false), 3000);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    onAction('removeContainer', container.id);
    setConfirmRemove(false); setMenuOpen(false);
  };

  const portsStr = container.ports.length
    ? container.ports.map(p => p.publicPort ? `${p.publicPort}:${p.privatePort}` : `${p.privatePort}`).join(', ')
    : '-';

  return (
    <div style={{ borderBottom: '1px solid var(--vscode-panel-border)' }}>
      <div
        onDoubleClick={() => setExpanded(e => !e)}
        title="Double-click to expand"
        style={{ padding: '7px 10px', display: 'flex', alignItems: 'center', gap: 8, borderLeft: `2px solid ${color}`, opacity: isRunning ? 1 : 0.65, cursor: 'default' }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span
          style={{ color: 'var(--vscode-foreground)', fontSize: '0.8em', flex: 1, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderBottom: container.isAutoNamed ? '1px dotted var(--vscode-descriptionForeground)' : 'none', cursor: container.isAutoNamed ? 'help' : 'default', position: 'relative' }}
          onMouseEnter={() => container.isAutoNamed && setShowTag(true)}
          onMouseLeave={() => setShowTag(false)}>
          {container.name}
          {showTag && <span style={{ position: 'absolute', top: -16, left: 0, background: '#3c3c3c', color: '#cccccc', fontSize: '8.5px', padding: '2px 5px', borderRadius: 2, whiteSpace: 'nowrap', zIndex: 10 }}>auto-named</span>}
        </span>
        {isRunning && stats ? (
          <>
            <span style={{ color: '#6a9955', fontSize: '0.72em', flexShrink: 0 }}>{stats.cpuPercent.toFixed(1)}%</span>
            <span style={{ color: '#569cd6', fontSize: '0.72em', flexShrink: 0 }}>{formatMem(stats.memUsageBytes)}</span>
          </>
        ) : (
          <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '0.72em', flexShrink: 0 }}>stopped</span>
        )}
        {isRunning && (
          <span onClick={() => onOpenLogs(container.id, container.name)} title="View logs"
            style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '0.8em', cursor: 'pointer', flexShrink: 0, padding: '0 2px' }}>▤</span>
        )}
        <span onClick={() => setMenuOpen(m => !m)} style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '0.8em', cursor: 'pointer', flexShrink: 0, padding: '0 2px' }}>⋯</span>
      </div>

      {expanded && (
        <div style={{ margin: '0 10px 8px', padding: '7px 8px', background: 'var(--vscode-sideBar-background)', border: '1px solid var(--vscode-panel-border)', borderRadius: 3, fontSize: '0.75em', color: 'var(--vscode-foreground)' }}>
          <div style={{ fontFamily: 'monospace', wordBreak: 'break-all', marginBottom: 4 }}>{container.image}</div>
          <div style={{ color: 'var(--vscode-descriptionForeground)' }}>id {container.id.slice(0, 12)} · ports {portsStr}</div>
          <div style={{ color: 'var(--vscode-descriptionForeground)' }}>created {timeAgo(container.created * 1000)}{container.composeProject ? ` · compose: ${container.composeProject}` : ''}</div>
          {stats && isRunning && (
            <div style={{ color: 'var(--vscode-descriptionForeground)', marginTop: 3 }}>
              CPU {stats.cpuPercent.toFixed(1)}% · MEM {formatMem(stats.memUsageBytes)}/{formatMem(stats.memLimitBytes)} · NET ↓{formatBytes(stats.netRxBytes)} ↑{formatBytes(stats.netTxBytes)}
            </div>
          )}
        </div>
      )}

      {menuOpen && (
        <div style={{ margin: '0 10px 6px', padding: '5px 6px', background: 'var(--vscode-sideBar-background)', border: '1px solid var(--vscode-panel-border)', borderRadius: 3, display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {!isRunning && <button onClick={() => onAction('startContainer', container.id)} style={menuBtnStyle()}>start</button>}
          {isRunning && (
            <>
              <button onClick={() => onAction('stopContainer', container.id)} style={menuBtnStyle()}>stop</button>
              <button onClick={() => onAction('restartContainer', container.id)} style={menuBtnStyle()}>restart</button>
              <button onClick={() => onAction(container.state === 'paused' ? 'unpauseContainer' : 'pauseContainer', container.id)} style={menuBtnStyle()}>{container.state === 'paused' ? 'unpause' : 'pause'}</button>
            </>
          )}
          <button onClick={handleRemoveClick} style={menuBtnStyle(confirmRemove ? '#c46a6a' : undefined)}>{confirmRemove ? 'confirm?' : 'remove…'}</button>
        </div>
      )}
    </div>
  );
}

function menuBtnStyle(color?: string): React.CSSProperties {
  return { background: 'none', border: `1px solid ${color ?? 'var(--vscode-panel-border)'}`, borderRadius: 2, color: color ?? 'var(--vscode-descriptionForeground)', fontSize: '0.72em', padding: '2px 7px', cursor: 'pointer' };
}

// ─── Main App ────────────────────────────────────────────────────────────────

const App: React.FC = () => {
  const [tab, setTab] = useState<'containers' | 'images'>('containers');
  const [containers, setContainers] = useState<ContainerSummary[]>([]);
  const [statsMap, setStatsMap] = useState<Record<string, ContainerStats>>({});
  const [images, setImages] = useState<ImageSummary[]>([]);
  const [events, setEvents] = useState<EventLine[]>([]);
  const [latestTick, setLatestTick] = useState('Watching containers…');
  const [showTimeline, setShowTimeline] = useState(false);
  const [showCharts, setShowCharts] = useState(false);
  const [search, setSearch] = useState('');
  const [onlyRunning, setOnlyRunning] = useState(false);
  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const [memHist, setMemHist] = useState<number[]>([]);
  const [vitals, setVitals] = useState<any>(null);
  const [composeDiff, setComposeDiff] = useState<any>(null);
  const [logView, setLogView] = useState<{ id: string; name: string; lines: LogLine[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const vscodeApi = useRef<{ postMessage: (msg: any) => void } | null>(null);
  const logBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // @ts-ignore
    vscodeApi.current = acquireVsCodeApi();
    vscodeApi.current?.postMessage({ type: 'ready' });
  }, []);

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [logView]);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (!msg?.type) return;
      switch (msg.type) {
        case 'containers': setContainers(msg.data ?? []); break;
        case 'stats':
          setStatsMap(prev => {
            const next = { ...prev };
            (msg.data ?? []).forEach((s: ContainerStats) => { next[s.id] = s; });
            return next;
          });
          break;
        case 'history': setCpuHist(msg.data?.cpu ?? []); setMemHist(msg.data?.mem ?? []); break;
        case 'vitals': setVitals(msg.data); break;
        case 'images': setImages(msg.data ?? []); break;
        case 'logs': setLogView({ id: msg.data.id, name: msg.data.id.slice(0, 12), lines: msg.data.lines ?? [] }); break;
        case 'logLine':
          setLogView(prev => prev && msg.data.id === prev.id
            ? { ...prev, lines: [...prev.lines.slice(-500), { line: msg.data.line, isStderr: false }] }
            : prev);
          break;
        case 'composeDiff': setComposeDiff(msg.data); break;
        case 'actionError':
          setErr(msg.data?.message ?? 'Action failed');
          setTimeout(() => setErr(null), 4000);
          break;
        case 'dockerEvent': {
          const ev = msg.data;
          const name = ev?.Actor?.Attributes?.name ?? ev?.id?.slice(0, 12) ?? 'container';
          const action = ev?.Action ?? 'event';
          const text = `${name} ${action}`;
          setLatestTick(text);
          setEvents(prev => [...prev.slice(-40), { id: `${Date.now()}-${Math.random()}`, text, timestamp: Date.now() }]);
          break;
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const post = (type: string, data?: any) => vscodeApi.current?.postMessage({ type, data });
  const openLogs = (id: string, name: string) => { setLogView({ id, name, lines: [{ line: 'Loading logs…', isStderr: false }] }); post('openLogs', { id }); };
  const closeLogs = () => { setLogView(null); post('closeLogs'); };

  const running = containers.filter(c => c.state === 'running');
  const stopped = containers.filter(c => c.state !== 'running');
  const q = search.trim().toLowerCase();
  const filtered = [...running, ...stopped].filter(c => {
    if (onlyRunning && c.state !== 'running') return false;
    if (!q) return true;
    return c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q) || c.id.toLowerCase().startsWith(q);
  });

  const totalCpu = Object.values(statsMap).reduce((s, x) => s + (x.cpuPercent || 0), 0);
  const totalMem = Object.values(statsMap).reduce((s, x) => s + (x.memUsageBytes || 0), 0);
  const cpuCount = vitals?.sys?.cpuCount || 0;
  const memTotal = vitals?.sys?.memTotalBytes || 0;
  const diskBytes = vitals?.disk?.layersSizeBytes || 0;
  const hasNvidia = vitals?.sys?.hasNvidiaRuntime;
  const isConnected = containers.length > 0 || events.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'var(--vscode-editor-font-family, monospace)', overflow: 'hidden', background: 'var(--vscode-editor-background)', fontSize: 13 }}>
      {/* System vitals header (Docker Desktop stats row, sidebar-compact) */}
      <div style={{ padding: '8px 10px 6px', borderBottom: '1px solid var(--vscode-panel-border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>CPU {cpuCount ? `/ ${cpuCount} CPUs` : ''}</div>
            <div style={{ fontSize: 14, color: '#6a9955', fontWeight: 600 }}>{totalCpu.toFixed(2)}%</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>Memory{memTotal ? ` / ${formatMem(memTotal)}` : ''}</div>
            <div style={{ fontSize: 14, color: '#569cd6', fontWeight: 600 }}>{formatMem(totalMem)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>Disk</div>
            <div style={{ fontSize: 14, color: 'var(--vscode-foreground)', fontWeight: 600 }}>{formatBytes(diskBytes)}</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            <span title={hasNvidia ? 'NVIDIA runtime detected (per-container GPU % is not exposed by Engine API)' : 'GPU % not exposed by Docker Engine API — NVIDIA runtime not detected'}
              style={{ fontSize: 10, padding: '1px 5px', borderRadius: 2, background: hasNvidia ? 'rgba(36,150,237,0.15)' : 'rgba(106,106,106,0.15)', color: hasNvidia ? DOCKER_BLUE : 'var(--vscode-descriptionForeground)' }}>
              GPU {hasNvidia ? 'ready' : 'n/a'}
            </span>
            <button onClick={() => setShowCharts(c => !c)} title="Show charts"
              style={{ background: showCharts ? 'var(--vscode-button-background)' : 'none', color: showCharts ? 'var(--vscode-button-foreground)' : 'var(--vscode-descriptionForeground)', border: '1px solid var(--vscode-panel-border)', borderRadius: 3, fontSize: 10, padding: '2px 7px', cursor: 'pointer' }}>
              {showCharts ? 'Hide charts' : 'Show charts'}
            </button>
          </div>
        </div>
        {showCharts && (
          <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
            <div><div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', marginBottom: 2 }}>CPU history</div><Sparkline data={cpuHist} color="#6a9955" /></div>
            <div><div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', marginBottom: 2 }}>MEM history</div><Sparkline data={memHist.map(v => v / (1024 * 1024))} color="#569cd6" /></div>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--vscode-panel-border)', flexShrink: 0 }}>
        {(['containers', 'images'] as const).map(t => (
          <div key={t} onClick={() => { setTab(t); if (t === 'images') post('refreshImages'); }}
            style={{ flex: 1, textAlign: 'center', padding: '6px 0', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', cursor: 'pointer', color: tab === t ? 'var(--vscode-foreground)' : 'var(--vscode-descriptionForeground)', borderBottom: tab === t ? `2px solid ${DOCKER_BLUE}` : '2px solid transparent' }}>
            {t} {t === 'containers' ? `(${containers.length})` : `(${images.length})`}
          </div>
        ))}
      </div>

      {/* Compose-diff banner (save-diff equivalent) */}
      {composeDiff && (
        <div style={{ padding: '5px 10px', fontSize: 11, background: 'var(--vscode-inputValidation-warningBackground)', color: 'var(--vscode-inputValidation-warningForeground)', borderBottom: '1px solid var(--vscode-inputValidation-warningBorder)', display: 'flex', justifyContent: 'space-between', flexShrink: 0 }}
          title="Snapshot before/after saving your compose file or Dockerfile. Temporal correlation, not proof of causation.">
          <span>↓ Changed after save {composeDiff.filename}: +{composeDiff.added.length} −{composeDiff.removed.length}</span>
          <button onClick={() => setComposeDiff(null)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>✕</button>
        </div>
      )}
      {err && (
        <div style={{ padding: '5px 10px', fontSize: 11, background: 'var(--vscode-inputValidation-errorBackground)', color: 'var(--vscode-inputValidation-errorForeground)', borderBottom: '1px solid var(--vscode-inputValidation-errorBorder)', flexShrink: 0 }}>{err}</div>
      )}

      {tab === 'containers' && (
        <>
          {/* Search + running-only (Docker Desktop parity, compact) */}
          <div style={{ display: 'flex', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--vscode-panel-border)', flexShrink: 0, alignItems: 'center' }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search containers…"
              style={{ flex: 1, background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border)', borderRadius: 3, padding: '4px 7px', fontSize: 12, outline: 'none' }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--vscode-descriptionForeground)', whiteSpace: 'nowrap', cursor: 'pointer' }}>
              <input type="checkbox" checked={onlyRunning} onChange={e => setOnlyRunning(e.target.checked)} /> running
            </label>
          </div>

          {/* Ambient ticker */}
          <div style={{ padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 6, borderBottom: '1px solid var(--vscode-panel-border)', flexShrink: 0 }}>
            <span style={{ color: DOCKER_BLUE, fontSize: 9 }}>●</span>
            <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{latestTick}</span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {filtered.length === 0 && (
              <div style={{ padding: '14px 10px', color: 'var(--vscode-descriptionForeground)', fontSize: 12 }}>
                {containers.length === 0 ? <>No containers found. Run <code style={{ color: '#dcdcaa' }}>docker run -d nginx</code> to see one appear here.</> : <>No containers match “{search}”.</>}
              </div>
            )}
            {filtered.map(c => (
              <ContainerRow key={c.id} container={c} stats={statsMap[c.id]}
                onAction={(a, id) => post(a, { id })} onOpenLogs={openLogs} />
            ))}
          </div>
        </>
      )}

      {tab === 'images' && (
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {images.length === 0 && <div style={{ padding: 12, color: 'var(--vscode-descriptionForeground)', fontSize: 12 }}>No images. Pull one with <code>docker pull nginx</code>.</div>}
          {images.map(img => (
            <div key={img.id} style={{ padding: '7px 10px', borderBottom: '1px solid var(--vscode-panel-border)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--vscode-foreground)', wordBreak: 'break-all' }}>{img.tags[0]}</div>
              <div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', marginTop: 2 }}>{img.id} · {formatBytes(img.sizeBytes)}{img.tags.length > 1 ? ` · +${img.tags.length - 1} tags` : ''}</div>
              <div style={{ marginTop: 4 }}>
                <button onClick={() => post('removeImage', { id: img.id })} style={menuBtnStyle()}>remove…</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Logs panel */}
      {logView && (
        <div style={{ borderTop: '1px solid var(--vscode-panel-border)', flexShrink: 0, display: 'flex', flexDirection: 'column', maxHeight: 220 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 10px', background: 'var(--vscode-sideBar-background)', borderBottom: '1px solid var(--vscode-panel-border)' }}>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vscode-descriptionForeground)' }}>Logs · {logView.name}</span>
            <button onClick={closeLogs} style={{ background: 'none', border: 'none', color: 'var(--vscode-descriptionForeground)', cursor: 'pointer' }}>✕</button>
          </div>
          <div ref={logBoxRef} style={{ overflowY: 'auto', padding: '6px 10px', fontFamily: 'monospace', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', flex: 1 }}>
            {logView.lines.map((l, i) => (
              <div key={i} style={{ color: l.isStderr ? 'var(--vscode-errorForeground)' : 'var(--vscode-editor-foreground)' }}>{l.line}</div>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div onClick={() => setShowTimeline(t => !t)}
        style={{ borderTop: '1px solid var(--vscode-panel-border)', padding: '6px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--vscode-sideBar-background)', cursor: 'pointer', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: isConnected ? DOCKER_BLUE : '#f48771', boxShadow: isConnected ? `0 0 4px ${DOCKER_BLUE}` : 'none' }} />
          <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: 11 }}>{running.length} · {stopped.length}</span>
        </div>
        <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: 11 }}>{showTimeline ? '▾' : '▸'}</span>
      </div>
      {showTimeline && (
        <div style={{ borderTop: '1px solid var(--vscode-panel-border)', maxHeight: 140, overflowY: 'auto', flexShrink: 0 }}>
          {[...events].reverse().map(e => (
            <div key={e.id} style={{ padding: '4px 10px', fontSize: 11, color: 'var(--vscode-descriptionForeground)', display: 'flex', justifyContent: 'space-between' }}>
              <span>{e.text}</span><span style={{ opacity: 0.6 }}>{timeAgo(e.timestamp)}</span>
            </div>
          ))}
          {events.length === 0 && <div style={{ padding: 8, fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>No events yet.</div>}
        </div>
      )}
    </div>
  );
};

export default App;
