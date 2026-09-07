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

type EventLine = { id: string; text: string; timestamp: number };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMem(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

const DOCKER_BLUE = '#2496ED';
const STOPPED_GRAY = '#6a6a6a';
const WARN_AMBER = '#dcdcaa';

function stateColor(state: string): string {
  if (state === 'running') return DOCKER_BLUE;
  if (state === 'restarting' || state === 'paused') return WARN_AMBER;
  return STOPPED_GRAY;
}

// ─── Container row ───────────────────────────────────────────────────────────

function ContainerRow({ container, stats, onAction }:
  { container: ContainerSummary; stats: ContainerStats | undefined; onAction: (action: string, id: string) => void }) {

  const [showTag, setShowTag] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
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
    setConfirmRemove(false);
    setMenuOpen(false);
  };

  return (
    <div style={{ borderBottom: '1px solid var(--vscode-panel-border)' }}>
      <div style={{
        padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8,
        borderLeft: `2px solid ${color}`, opacity: isRunning ? 1 : 0.6,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />

        <span
          style={{
            color: 'var(--vscode-foreground)', fontSize: '0.72em', flex: 1, fontWeight: 500,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            borderBottom: container.isAutoNamed ? '1px dotted var(--vscode-descriptionForeground)' : 'none',
            cursor: container.isAutoNamed ? 'help' : 'default', position: 'relative', width: 'fit-content',
          }}
          onMouseEnter={() => container.isAutoNamed && setShowTag(true)}
          onMouseLeave={() => setShowTag(false)}
        >
          {container.name}
          {showTag && (
            <span style={{
              position: 'absolute', top: -16, left: 0, background: '#3c3c3c', color: '#cccccc',
              fontSize: '8.5px', padding: '2px 5px', borderRadius: 2, whiteSpace: 'nowrap',
              boxShadow: '0 2px 6px rgba(0,0,0,0.4)', zIndex: 10,
            }}>
              auto-named
            </span>
          )}
        </span>

        {isRunning && stats ? (
          <>
            <span style={{ color: '#6a9955', fontSize: '0.65em', flexShrink: 0 }}>{stats.cpuPercent.toFixed(1)}%</span>
            <span style={{ color: '#569cd6', fontSize: '0.65em', flexShrink: 0 }}>{formatMem(stats.memUsageBytes)}</span>
          </>
        ) : (
          <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '0.65em', flexShrink: 0 }}>stopped</span>
        )}

        <span
          onClick={() => setMenuOpen(m => !m)}
          style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '0.75em', cursor: 'pointer', flexShrink: 0, padding: '0 2px' }}
        >
          ⋯
        </span>
      </div>

      {menuOpen && (
        <div style={{ margin: '0 10px 6px', padding: '5px 6px', background: 'var(--vscode-sideBar-background)', border: '1px solid var(--vscode-panel-border)', borderRadius: 3, display: 'flex', gap: 5 }}>
          {!isRunning && (
            <button onClick={() => onAction('startContainer', container.id)} style={menuBtnStyle()}>start</button>
          )}
          {isRunning && (
            <>
              <button onClick={() => onAction('stopContainer', container.id)} style={menuBtnStyle()}>stop</button>
              <button onClick={() => onAction('restartContainer', container.id)} style={menuBtnStyle()}>restart</button>
            </>
          )}
          <button onClick={handleRemoveClick} style={menuBtnStyle(confirmRemove ? '#c46a6a' : undefined)}>
            {confirmRemove ? 'confirm?' : 'remove…'}
          </button>
        </div>
      )}
    </div>
  );
}

function menuBtnStyle(color?: string): React.CSSProperties {
  return {
    background: 'none', border: `1px solid ${color ?? 'var(--vscode-panel-border)'}`,
    borderRadius: 2, color: color ?? 'var(--vscode-descriptionForeground)',
    fontSize: '0.68em', padding: '2px 7px', cursor: 'pointer',
  };
}

// ─── Timeline (hidden behind footer toggle) ─────────────────────────────────

function Timeline({ events }: { events: EventLine[] }) {
  function timeAgo(ts: number) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5) return 'now';
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m`;
  }

  return (
    <div style={{ borderTop: '1px solid var(--vscode-panel-border)', maxHeight: 140, overflowY: 'auto' }}>
      {[...events].reverse().map(e => (
        <div key={e.id} style={{ padding: '4px 10px', fontSize: '0.68em', color: 'var(--vscode-descriptionForeground)', display: 'flex', justifyContent: 'space-between' }}>
          <span>{e.text}</span>
          <span style={{ opacity: 0.6 }}>{timeAgo(e.timestamp)}</span>
        </div>
      ))}
      {events.length === 0 && (
        <div style={{ padding: '8px 10px', fontSize: '0.72em', color: 'var(--vscode-descriptionForeground)' }}>No events yet.</div>
      )}
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────

const App: React.FC = () => {
  const [containers, setContainers] = useState<ContainerSummary[]>([]);
  const [statsMap, setStatsMap] = useState<Record<string, ContainerStats>>({});
  const [events, setEvents] = useState<EventLine[]>([]);
  const [latestTick, setLatestTick] = useState<string>('Watching containers…');
  const [showTimeline, setShowTimeline] = useState(false);

  const vscodeApi = useRef<{ postMessage: (msg: any) => void } | null>(null);

  useEffect(() => {
    // @ts-ignore
    vscodeApi.current = acquireVsCodeApi();
    vscodeApi.current?.postMessage({ type: 'ready' });
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (!msg?.type) return;
      switch (msg.type) {
        case 'containers':
          setContainers(msg.data ?? []);
          break;
        case 'stats':
          setStatsMap(prev => {
            const next = { ...prev };
            (msg.data ?? []).forEach((s: ContainerStats) => { next[s.id] = s; });
            return next;
          });
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

  const handleAction = (action: string, id: string) => {
    vscodeApi.current?.postMessage({ type: action, data: { id } });
  };

  const running = containers.filter(c => c.state === 'running');
  const stopped = containers.filter(c => c.state !== 'running');
  const isConnected = containers.length > 0 || events.length > 0;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      fontFamily: 'var(--vscode-editor-font-family, monospace)',
      overflow: 'hidden', background: 'var(--vscode-editor-background)',
    }}>
      {/* Single-line ambient ticker */}
      <div style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 6, borderBottom: '1px solid var(--vscode-panel-border)', flexShrink: 0 }}>
        <span style={{ color: DOCKER_BLUE, fontSize: '9px' }}>●</span>
        <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '0.72em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {latestTick}
        </span>
      </div>

      {/* Container rows */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {containers.length === 0 && (
          <div style={{ padding: '14px 10px', color: 'var(--vscode-descriptionForeground)', fontSize: '0.78em' }}>
            No containers found. Run <code style={{ color: '#dcdcaa' }}>docker run -d nginx</code> to see one appear here.
          </div>
        )}
        {[...running, ...stopped].map(c => (
          <ContainerRow key={c.id} container={c} stats={statsMap[c.id]} onAction={handleAction} />
        ))}
      </div>

      {/* Timeline, hidden by default */}
      {showTimeline && <Timeline events={events} />}

      {/* Minimal icon-first footer */}
      <div
        onClick={() => setShowTimeline(t => !t)}
        style={{
          borderTop: '1px solid var(--vscode-panel-border)', padding: '6px 10px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'var(--vscode-sideBar-background)', cursor: 'pointer', flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: isConnected ? DOCKER_BLUE : '#f48771',
            boxShadow: isConnected ? `0 0 4px ${DOCKER_BLUE}` : 'none',
          }} />
          <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '0.68em' }}>
            {running.length} · {stopped.length}
          </span>
        </div>
        <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '0.7em' }}>{showTimeline ? '▾' : '▸'}</span>
      </div>
    </div>
  );
};

export default App;
