# Docker Vitals

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/ps-aditya.docker-vitals?label=Marketplace&color=007ACC)](https://marketplace.visualstudio.com/items?itemName=ps-aditya.docker-vitals)
[![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/ps-aditya.docker-vitals?color=007ACC)](https://marketplace.visualstudio.com/items?itemName=ps-aditya.docker-vitals)
[![VS Code](https://img.shields.io/badge/VS_Code-%5E1.85.0-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

See what your containers are doing, without leaving VS Code.

Docker Vitals is a sidebar panel that shows your running containers, their live CPU and memory usage, and a timeline of what changed — all updating in real time. Save a `docker-compose.yml` or `Dockerfile` and it tells you exactly what happened to your containers as a result.

Unofficial. Not affiliated with Docker Inc. No data leaves your machine — no telemetry, no backend, no network calls beyond your own Docker daemon.

## Installation

**From the Marketplace** (recommended):

Search for "Docker Vitals" in the Extensions view, or use Quick Open (`Ctrl+P`):

```
ext install ps-aditya.docker-vitals
```

**From a `.vsix` file:**

Download or build a [`docker-vitals-*.vsix`](https://github.com/ps-aditya/docker-vitals/releases), then:

```
code --install-extension docker-vitals-0.1.1.vsix
```

Or in VS Code: Extensions view → `···` menu → *Install from VSIX…*

**From source:** see [Development](#development) below.

## Getting started

1. Start Docker Desktop (or your Docker daemon).
2. Open the Docker Vitals icon in the activity bar.
3. That's it. Containers appear automatically.

No backend. No CLI wrapping. It talks directly to the Docker Engine API.

Remote daemon? `Ctrl+Shift+P` → `Docker Vitals: Set Remote Host…` → `tcp://host:2375`.

## What you get

**Containers.** Running and stopped, with live CPU % and memory per container. Double-click a row to expand image, ports, created time, compose project, network I/O.

**Lifecycle actions.** Start, stop, restart, pause, unpause, remove — from the row menu (`⋯`). Removing asks for a second confirmation; nothing is destroyed by a mis-click.

**Show charts.** Rolling CPU and memory history per session (last 30 samples). A leaking container shows up as a shape, not a number you had to be staring at.

**Images.** Pulled images with size and tags. Remove what you don't need.

**Logs.** `▤` on any running container streams stdout/stderr live, tail of the last 100 lines first.

**Timeline.** Every container event — start, stop, die, restart — recorded with a timestamp. Save a compose file or Dockerfile and a diff entry shows what changed as a result. Temporal correlation, not proof of causation.

**Status bar.** Connection state plus running/stopped counts, always visible. It flashes when a count changes, so you notice a container died while you were in another tab.

**Search.** Filter by name, image, or id prefix. Toggle running-only.

## Commands

| Command | What it does |
|---|---|
| `Docker Vitals: Open Panel` | Open the sidebar |
| `Docker Vitals: Reconnect to Docker` | Retry the daemon connection |
| `Docker Vitals: Set Remote Host…` | Point at a remote daemon (empty = local) |

## Settings

| Setting | Default | Description |
|---|---|---|
| `docker-vitals.dockerHost` | `""` | Remote host (`tcp://host:2375`), empty = local socket |
| `docker-vitals.pollInterval` | `2000` | Stats refresh interval (ms), 500–60000 |

## How it works

Everything runs inside the VS Code extension host. There is no `docker` CLI subprocess and no sidecar server.

* **Connection.** [dockerode](https://github.com/apocas/dockerode) speaks the Docker Engine API directly: named pipe `//./pipe/docker_engine` on Windows, `/var/run/docker.sock` on macOS/Linux, or `tcp://host:2375` when `dockerHost` is set. The daemon is ping-verified before the panel declares itself connected.
* **Never blocks activation.** The connect attempt is fire-and-forget on activation. A slow or unreachable daemon cannot stall the extension host, and the welcome view offers a retry button instead.
* **Push + poll.** Container events arrive over the daemon's push-based event stream (`/events`, filtered to `container`), so the list refreshes the instant something starts or dies. Resource stats are polled on `pollInterval` (2s default); disk/system vitals every 15s. Polling stops entirely while the sidebar is hidden.
* **CPU math.** Same delta formula as `docker stats`: `cpu_delta / system_delta × online_cpus × 100`, computed from two consecutive samples. A container that just started needs one poll tick before the number is meaningful.
* **Compose-diff.** On save of any `Dockerfile`, `docker-compose*.yml`, or `compose*.yml`, the extension snapshots `name@image:state`, waits 1.5s for the daemon to act, then diffs against the previous snapshot. Added/removed containers land in the timeline.
* **Webview.** The panel is a React 18 app bundled by Vite into a single `media/webview-dist/webview.js`. It is served with a per-load nonce and a `default-src 'none'` CSP — no remote scripts, no inline eval, no external requests.
* **Security posture.** The extension talks only to your Docker daemon. It has no analytics, no crash reporting, and makes no network calls of its own.

## Development

Prerequisites: Node.js 18+, npm, VS Code 1.85+, and a running Docker daemon.

```bash
git clone https://github.com/ps-aditya/docker-vitals.git
cd docker-vitals
npm install          # extension host deps (dockerode, esbuild, typescript)
cd webview && npm install && npm run build && cd ..
```

Two independent build pipelines:

| What | Command | Output |
|---|---|---|
| Extension host code | `npm run watch` (or `npm run compile`) | `out/extension.js` via esbuild |
| Webview UI | `cd webview && npm run dev` (or `npm run build`) | `media/webview-dist/` via Vite |

To try it: press **F5** (*Run Extension*) — this compiles and opens an Extension Development Host with the extension loaded. Make a change, rebuild, and reload the dev host window (`Ctrl+R`).

To package a `.vsix`:

```bash
npm install -g @vscode/vsce
npm run compile
cd webview && npm run build && cd ..
vsce package
code --install-extension docker-vitals-<version>.vsix
```

Release checklist: bump the version in `package.json` (and `webview/package.json` if the UI changed), update `CHANGELOG.md`, commit, `vsce publish`, and tag.

### Project structure

```
├── src/
│   ├── extension.ts            # activation, commands, status bar, compose-save watcher
│   ├── services/
│   │   └── DockerBridge.ts     # dockerode client: connect, event stream, stats, actions, logs
│   └── providers/
│       └── SidebarProvider.ts  # webview host: polling, message routing, compose-diff
├── webview/
│   └── src/
│       ├── App.tsx             # the entire panel UI
│       └── main.tsx
├── media/
│   ├── icon.png                # Marketplace icon
│   ├── icon-activity.svg       # activity-bar icon
│   └── webview-dist/           # built webview bundle (committed)
├── esbuild.js                  # bundles src/ → out/extension.js
└── package.json                # manifest: views, commands, settings
```

## Notes

* CPU/memory header is aggregated from running containers plus daemon totals. Close to Docker Desktop, minus Desktop VM overhead. Disk comes from the Engine API directly.
* Per-container GPU % is not exposed by the Docker Engine API. The GPU badge shows whether an NVIDIA runtime is present, nothing more.
* Auto-generated names (`silly_darwin` style) get a dotted underline and an `auto-named` hover tag.
* In remote setups (WSL, SSH, Dev Containers) the extension host runs on the remote side. If the daemon is not reachable from there, set `docker-vitals.dockerHost` to one that is.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "No Docker connection detected" welcome view | Start Docker Desktop, then click *Retry Connection* or run `Docker Vitals: Reconnect to Docker`. |
| Status bar stuck on "offline" (Windows) | The named pipe `//./pipe/docker_engine` is missing — Docker Desktop isn't running or is still starting. |
| Remote host won't connect | Use the `tcp://host:2375` form. The daemon must listen on TCP (e.g. Docker Desktop → Settings → *Expose daemon on tcp://localhost:2375 without TLS*), and the port must be open through the firewall. |
| CPU shows 0% right after start | Stats need two samples. Wait one `pollInterval` tick. |
| Container vanished from the panel | It was removed. The timeline keeps the event with a timestamp. |
| Image removal fails with "image is in use" | Stop and remove the dependent containers first — force-removing an image doesn't evict running containers. |

## Requirements

* VS Code 1.85+
* Docker Desktop running, or a reachable daemon

## Contributing

Issues and pull requests are welcome at [github.com/ps-aditya/docker-vitals](https://github.com/ps-aditya/docker-vitals). For anything touching the Docker connection, note your platform (Windows/macOS/Linux), Docker version, and whether the daemon is local or remote — that's what makes connection bugs diagnosable.

## License

MIT. See [LICENSE](./LICENSE).
