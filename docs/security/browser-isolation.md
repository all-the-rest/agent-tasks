# Browser isolation

## Layers

| Layer | Setting |
| --- | --- |
| Container | non-root `pwuser`, `cap_drop: ALL`, `no-new-privileges`, read-only root, tmpfs `/tmp` and `/dev/shm`, `pids_limit: 256`, memory/CPU limits |
| Seccomp | Docker's upstream default profile, pinned in `docker/seccomp-browser.json` (no relaxations) |
| Network | only the private `backend` compose network (not `internal: true`); no published port; no Docker socket; no host networking. Egress is enforced in the proxy, not by the network |
| Chromium | sandbox enabled (`chromiumSandbox: true`), no `--no-sandbox`, no remote debugging port |
| Session | one `BrowserContext` per execution, `acceptDownloads: false`, service workers blocked, non-http(s) routes aborted, closed after the execution or after the TTL |
| Egress | all traffic through the in-process proxy; DNS resolved there, all answers must be public, connection pinned to a checked IP |

## Why a proxy and not just URL validation

`page.goto('https://example.com')` performs DNS inside Chromium. A hostile domain can
answer once with a public IP for the check and once with `127.0.0.1` for the
connection (DNS rebinding), and redirects change the target after the check. The proxy
removes both: Chromium cannot resolve names at all, and each redirect is a new
CONNECT that is validated again.

## What is not covered

- `BrowserContext` isolation is not an OS boundary. A Chromium exploit could leave the
  context; the container is the boundary. Per-execution containers are the next step.
- The sandbox needs user namespaces (or the setuid helper) on the host. Where the
  kernel forbids them, Chromium refuses to start; the runner logs
  `sandbox_disabled` and must not be used in production in that mode.
- `RUNNER_CHROMIUM_SANDBOX=false` exists only for such hosts (for example the CI
  environment used for this repository's verification run). `compose.yaml` pins the
  variable to `"true"`, so disabling it requires editing the browser-runner service.
