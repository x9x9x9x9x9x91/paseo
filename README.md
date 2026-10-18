# QA: an agent on a custom provider has its workspace named on that provider only

`run.sh <label> <repo> <port> <waitMs>` starts a throwaway daemon from `<repo>` with its own `PASEO_HOME` and the providers in `config.json`: the built-in `claude` and a custom `claude-private`, each pointed at its own local stand-in for the Anthropic API (`stub.mjs`). A stand-in logs every request and refuses it with 401, so nothing runs and no key is needed. `create-workspace.mts` then sends the app's request, `workspace.create` with an initial agent on `claude-private`, first message `QA-7731 private plan: rework the billing flow`, and waits.

Each log line is one request one of the stand-ins received, with `firstMessageInBody` true when the request carried the first message.

- `main-endpoints.log`: daemon built from `main` 2a9e86b54. The built-in endpoint gets the namer's requests (`claude-haiku-4-5`) with the first message.
- `branch-endpoints.log`: daemon built from the pull request's branch. The built-in endpoint gets only the Claude CLI's startup probe (`HEAD /api/hello`, no body); the namer's requests go to `claude-private`.

Run on macOS (arm64), Node 22, Claude Code 2.1.284, with a 90 s wait:

```bash
./run.sh main  ~/paseo-main   7821 90000
./run.sh branch ~/paseo-branch 7822 90000
```
