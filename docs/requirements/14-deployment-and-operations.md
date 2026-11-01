# Docker Compose deployment, Portainer auto-update, documentation

_Labels: deploy, docs_

## Acceptance criteria

- [x] Compose stack: api (+ SPA), worker, postgres, hardened browser runner
- [x] Optional profiles: SearXNG (search), Mailpit (mail)
- [x] Named volumes, health checks, restart policies, no published database port
- [x] Pinned images, minimal privileges, seccomp profile
- [x] Watchtower labels for api/worker only
- [x] README, ARCHITECTURE, SECURITY, DEPLOYMENT, TESTING, CONTRIBUTING, CHANGELOG, .env.example
- [ ] Full compose start verified in this environment (Docker daemon is remote; see VERIFICATION_REPORT)

## Evidence

`compose.yaml`, `docker/`, `DEPLOYMENT.md`.
