#!/bin/zsh
# Installs the fork's release job on this Mac (sincoder): the tools clone the launch agent
# runs from, the build clone it rebases in, and the launch agent itself. Safe to run again;
# --clones-only stops before the launch agent (for a hand run with --dry-run). The build host
# needs nothing installed: each run sets up what it uses there (fork/README.md, The job).
set -euo pipefail

root=${PASEO_FORK_ROOT:-$HOME/Coding/_forks/paseo-release}
fork=https://github.com/x9x9x9x9x9x91/paseo.git
upstream=https://github.com/getpaseo/paseo.git
label=com.alma.paseo-fork-release
here=${0:A:h}

mkdir -p "$root"
if [[ ! -d $root/tools/.git ]]; then
  git clone -q --depth 1 --branch fork/release "$fork" "$root/tools"
fi
if [[ ! -d $root/build/.git ]]; then
  git clone -q "$fork" "$root/build"
  git -C "$root/build" remote add upstream "$upstream"
fi

if [[ ${1:-} == --clones-only ]]; then
  echo "clones ready in $root; launch agent not installed"
  exit 0
fi

plist=$HOME/Library/LaunchAgents/$label.plist
sed -e "s|__HOME__|$HOME|g" -e "s|__ROOT__|$root|g" "$here/$label.plist" > "$plist"
plutil -lint "$plist" > /dev/null
launchctl bootout "gui/$(id -u)/$label" 2> /dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "installed $label: runs now and hourly; log ~/Library/Logs/paseo-fork-release.log, runs in $root/runs"
