# Skills-Marker

agents-skills-consumed: 91a58a3
geprüft am: 2026-10-31

## Skill-Stand

| Skill | angewendet? | wo im Projekt | offene Position |
|---|---|---|---|
| `codegraph-project-setup` | ja | `.codegraph/`, `.githooks/pre-commit`, `AGENTS.md` | |
| `project-gates` | ja | `ratchet.config.jsonc` (Preset `agent-rules`), `ratchet.baseline.json`, `.ratchet-version`, `.githooks/pre-commit`, `.github/workflows/ci.yml` | |
| `ratchet-gates` | ja | `ratchet.config.jsonc`, `ratchet.baseline.json` | |
| `github-ci-filters` | ja | `.github/workflows/ci.yml` (`paths-ignore`) | Doku-Pushes überspringen den CI-Lauf; der lokale Secret-Scan bleibt |
| `ui-review` | ja | `scripts/capture-readme-screenshots.mjs`, `docs/images/`, `docs/USER_GUIDE.md` | |
| `build-verify` | nein | | nicht adoptiert; Commits nutzen einen `Verify:`-Footer |
| `docker-test-image` | nein | | Compose baut lokale Dockerfiles, kein CI-Test-Image |

## Fortschreiben

1. `agents-skills-consumed` ablesen → `<alt>`.
2. Im Skills-Repo die Range bilden:
   `git -C /projects/agents-skills log --oneline <alt>..HEAD`
3. Jeden betroffenen Skill gegen dieses Projekt prüfen und die Tabelle
   fortschreiben; danach den Marker auf den neuen SHA und das Prüfdatum setzen.
