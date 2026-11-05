# Browser isolation

## Layers

| Layer | Setting |
| --- | --- |
| Container | non-root `pwuser`, `cap_drop: ALL` + `cap_add: SYS_CHROOT`, `no-new-privileges`, read-only root, tmpfs `/tmp` and `/dev/shm`, `pids_limit: 256`, memory/CPU limits |
| Seccomp | strict allow-list based on Docker's default (`docker/seccomp-browser.json`); unprivileged `unshare`/`clone` with `CLONE_NEWUSER` are allowed for Chromium's user-namespace sandbox, every other namespace operation still requires `CAP_SYS_ADMIN` |
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

## Robots.txt enforcement and operator responsibility

The runner enforces `robots.txt` for every main-frame navigation, including
redirect targets and navigations initiated by browser actions. Ordinary page
subresources are not checked against robots rules. The crawler sends the same
user-agent on page requests and robots requests:
`AgentTasksResearchBot/0.2` (robots product token `AgentTasksResearchBot`).

Robots files are fetched without opening them as pages, through the browser
runner's SSRF-enforcing proxy with URL/port validation, public-address resolution
and pinned connections. Redirects are revalidated at each hop and limited to
five; responses are limited to 512 KiB and five seconds. Successful files and
4xx “unavailable” responses are cached per execution and origin for ten minutes;
server errors and fetch failures deny navigation and are cached for 30 seconds.
Each execution is limited to 100 cached origins and 100 fetches. A 4xx robots response
permits crawling, consistent with RFC 9309; 5xx and unreachable files fail
closed. Rules use the most-specific matching user-agent group, longest matching
path precedence, `Allow` on ties, and support `*` and terminal `$` patterns.

Site terms of service, licensing terms and site-specific rate limits remain
operator responsibilities; they cannot be reliably inferred or enforced by a
generic crawler. Operators must still check applicable terms and must not use
agents to bypass paywalls, login walls or captchas.

Captcha and paywall bypass is explicitly out of scope for this project. The
browser runner refuses login, checkout, payment and destructive controls, and
form submission is disabled by policy.

## What is not covered

- `BrowserContext` isolation is not an OS boundary. A Chromium exploit could leave the
  context; the container is the boundary. Per-execution containers are the next step.
- The sandbox needs unprivileged user namespaces in the host kernel. The shipped
  profile allows the two syscalls Chromium needs (`unshare(CLONE_NEWUSER)` and
  `clone(CLONE_NEWUSER|CLONE_NEWPID|CLONE_NEWNET)`), and `CAP_SYS_CHROOT` is kept
  for the sandbox's chroot. Where the kernel forbids user namespaces, Chromium
  refuses to start; the runner then exits unless `RUNNER_CHROMIUM_SANDBOX=false`
  is set explicitly, which logs `sandbox_disabled` and must not be used in
  production.
- The Playwright base image alone does not enable the sandbox: it ships browsers
  but no `playwright` npm package, its `chrome_sandbox` is mode `0777` (not
  setuid) and it runs as root by default. Running it as `pwuser` with the profile
  above is what makes the sandbox work; this is verified in CI by the compose job
  and by `docker/seccomp-browser.json`'s regression test.
- `RUNNER_CHROMIUM_SANDBOX=false` exists only for hosts without user namespaces.
  `compose.yaml` pins the variable to `"true"`, so disabling it requires editing
  the browser-runner service.
