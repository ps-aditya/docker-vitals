# Changelog

## 0.1.1 — System vitals, charts, images, logs

* System header: CPU, memory, real disk usage (`docker.df()`), GPU runtime badge
* `Show charts` toggle with rolling CPU/memory history sparklines
* Images tab: list, sizes, tags, remove
* Live log streaming per container (`▤`)
* Compose-diff banner on Dockerfile / `docker-compose*.yml` save
* Remote daemon support via `Set Remote Host…` command
* Search + running-only filter, double-click row to expand details
* Action errors now surface in the panel instead of failing silently

## 0.1.0 — Initial release

* Sidebar panel: container list with live CPU/memory, double-click expand
* Show charts: rolling CPU/memory history
* Images tab: list, sizes, remove
* Live log streaming per container
* Event timeline + compose-diff on Dockerfile/compose save
* System header: CPU, memory, real disk usage, GPU runtime badge
* Search + running-only filter
* Remote daemon support via `dockerHost` setting
* Safe two-step remove confirmation
