#!/bin/zsh
# run.sh <label> <repo> <port> <waitMs>: a throwaway daemon with two stand-in endpoints, one workspace
# opened on the custom provider, then which endpoint saw the first message.
set -u
label=$1 repo=$2 port=$3 wait=${4:-25000}
qa=/tmp/paseo-naming-qa/$label
scripts=$(dirname $0)
marker="QA-7731 private plan"
rm -rf $qa && mkdir -p $qa/home $qa/project $qa/claude-builtin $qa/claude-private
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
git -C $qa/project init -q && echo "# qa" > $qa/project/README.md
cat > $qa/home/config.json <<JSON
{
  "agents": {
    "providers": {
      "claude": {
        "env": {
          "ANTHROPIC_API_KEY": "qa-key-builtin",
          "ANTHROPIC_BASE_URL": "http://127.0.0.1:7801",
          "CLAUDE_CONFIG_DIR": "$qa/claude-builtin",
          "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
        }
      },
      "claude-private": {
        "extends": "claude",
        "label": "Claude (private)",
        "env": {
          "ANTHROPIC_API_KEY": "qa-key-private",
          "ANTHROPIC_BASE_URL": "http://127.0.0.1:7802",
          "CLAUDE_CONFIG_DIR": "$qa/claude-private",
          "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
        }
      },
      "codex": { "enabled": false },
      "copilot": { "enabled": false },
      "opencode": { "enabled": false },
      "pi": { "enabled": false }
    }
  }
}
JSON
node $scripts/stub.mjs 7801 "built-in claude (127.0.0.1:7801)" $qa/endpoints.log "$marker" & stub1=$!
node $scripts/stub.mjs 7802 "claude-private (127.0.0.1:7802)" $qa/endpoints.log "$marker" & stub2=$!
( cd $repo/packages/server && PASEO_HOME=$qa/home PASEO_LISTEN=127.0.0.1:$port PASEO_RELAY_ENABLED=false \
    node dist/scripts/supervisor-entrypoint.js > $qa/daemon.log 2>&1 ) & daemon=$!
for i in {1..60}; do grep -q "listening\|Listening\|server started\|ready" $qa/daemon.log 2>/dev/null && break; sleep 1; done
sleep 5
echo "== $label: daemon $(git -C $repo rev-parse --short HEAD) on 127.0.0.1:$port"
( cd $repo/packages/cli && PASEO_HOME=$qa/home npx tsx $scripts/create-workspace.mts $repo 127.0.0.1:$port $qa/project claude-private "$marker: rework the billing flow" $wait )
echo "== requests the endpoints saw:"
cat $qa/endpoints.log 2>/dev/null || echo "(none)"
echo "== naming lines in the daemon log:"
grep -i "branch name\|metadata\|structured" $qa/daemon.log | cut -c1-400 | head -12
kill $daemon $stub1 $stub2 2>/dev/null; sleep 2; pkill -f "PASEO_HOME=$qa" 2>/dev/null
pgrep -f "$qa/home" | xargs kill 2>/dev/null
echo "== done $label"
