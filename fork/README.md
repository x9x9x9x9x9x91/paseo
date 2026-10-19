# The fork's release line

This fork ships Paseo's desktop app with features upstream has not merged yet. `fork/release` is upstream's latest stable tag plus the fork's own commits, and every upstream stable release gets a fork release the same day. Today that is:

- the Quote button: select text in an agent message and quote it into the composer, upstream pull [#7176](https://github.com/getpaseo/paseo/pull/7176);
- a daemon patch: a chat on a custom provider (the zero-retention Claude) has its workspace named, and its checkout's commit and pull request text written, on that provider only, upstream pull [#7313](https://github.com/getpaseo/paseo/pull/7313). Upstream names on the first provider with a Haiku, whatever provider the chat runs on, so a private chat's first message reached the subscription;
- the projects choice in Settings > Notifications: count every project toward the Dock badge and the OS banners, or only the chosen ones. It has no upstream pull (`Upstream: none`), so it holds the retirement while it is on the branch.

## What a fork release changes

The app (`packages/app`), the build config (the update feed in `packages/desktop/electron-builder.yml`, this folder, and the packaged-app smoke's deadline in `packages/desktop/e2e/packaged-app-smoke.js`, raised from upstream's 60 s to 240 s because the build Mac is shared and a loaded one cold-starts the daemon past a minute), and the daemon patch's files, listed with their tests in `DAEMON_PATCH_FILES` and `DAEMON_PATCH_TESTS` in `release.mjs`. The rest of the daemon, the CLI, the desktop shell and the lockfile are upstream's source of the same tag; the job refuses to build a branch that changes anything else. Swapping the app leaves a running daemon alone: the desktop app stops only a daemon it started itself, so the daemon patch takes effect at the daemon's next restart. The daemon patch is written on the fork's stable base; its upstream pull's branch, `custom-provider-naming`, is the same change on upstream's main, so when the rebase onto the next stable tag stops in its files (`create-agent/create.ts`, `tools/paseo-tools.ts`, `schedule/service.ts`, and the create test's call, which gains upstream's third argument), resolve the conflict by taking that branch's version of the file.

Commits that belong to the fork itself (the feed, this job) start with `fork: `. Every other commit is a feature, and its upstream pull goes in `UPSTREAM_PULLS` in `release.mjs`. A feature with no upstream pull carries the trailer `Upstream: none` in its message.

## Versions

A fork release is the upstream version plus `-fork.N`: `0.11.4-fork.1`, then `0.11.4-fork.2` when a commit lands on `fork/release` before upstream's next release, then `0.11.5-fork.1`. The tag and the GitHub release carry the same name, without a `v`, so upstream's release workflows (triggered by `v*` tags) never match it.

Semver reads `0.11.4-fork.1` newer than every older upstream release and every earlier fork build, so the app updates; the app keeps the stock `latest` channel. The renderer reads its version from `packages/app`, which stays upstream's, so the app/daemon version check compares `0.11.4` with the daemon's `0.11.4`.

## Signing

Electron's updater on macOS installs a build only when it satisfies the running app's designated requirement, which by default names the one team that signed the app: a stock app (signed by upstream's team, `99ZMJMKU9Y`) never takes a fork build. The job signs through `sign-mac.cjs`, which gives the fork app a designated requirement naming Paseo's identifier `sh.paseo.desktop` and either team, the fork's `HKM8HFGKC6` or upstream's, so a fork app could take stock Paseo; the helpers inside keep their own requirements. What it takes is still only what its feed offers, and the fork's feed offers fork builds until the handover below. Pinned to the identifier, the requirement admits no other app from either team. The job's verify step refuses a build whose requirement is not this one, and codesign refuses one that does not satisfy its own.

## The job

`release.mjs` runs hourly on sincoder as the launch agent `com.alma.paseo-fork-release`, inside the logged-in session, because the Developer ID key and the `substrate-notary` profile live in its login keychain, which is locked over ssh. `install.sh` sets it up under `~/Coding/_forks/paseo-release`: `tools/` follows `fork/release` and holds the job, `build/` is where it rebases and builds. Each run with something to do leaves its logs in `runs/<time>/`; `state.json` and `job.log` say what it last did.

A run asks GitHub for upstream's latest release (published, not a prerelease), then:

1. A newer upstream release: rebase the branch onto its tag. On a conflict, a headless agent tries once; it reaches sin0's model proxy through an ssh tunnel, since sincoder has no login of its own. If it cannot resolve the conflict, Tim gets a notice with the conflict and the app stays on the last release.
2. Check: typecheck, lint, format, this folder's tests, the app's unit tests, the daemon patch's tests and the features' Playwright specs (every browser spec the branch adds or changes on upstream's tag, read from the branch, so a new feature's spec runs with nothing to list; a feature is gated by the spec it adds or changes, and a branch that changes the app with none fails the run), on the Node major upstream's release workflow uses.
3. Build the arm64 app, signed with `Developer ID Application: Tim Roth (HKM8HFGKC6)` and notarized, then verify the signature, the notarization, the version and the feed inside the app.
4. Push the rebased branch and publish the release, with `latest-mac.yml`, the zip and dmg and their blockmaps, marked latest.

It publishes only when every step passed. A failure keeps the previous release and goes to Tim's notifications on sin0 through Alma's door, as source `paseo-fork`; the same upstream release and branch are retried for three runs, then the job waits for a new upstream release or a new commit. Every run copies `state.json` to sin0, where Alma's sched_watch warns when the job has not checked upstream for 12 hours, sincoder being down included.

Run it by hand on sincoder through `~/bin/gui-run.sh` so it gets the session's keychain. `--dry-run` builds, signs, notarizes and verifies without pushing, publishing or notifying; `--branch <name>` builds another branch of the fork, `--force` builds a branch that is already released and `--retire` builds the handover below from upstream's latest release, all three with `--dry-run` only.

## Retirement

When upstream merges the features, the fork hands the app back and stops. A run retires when every pull in `UPSTREAM_PULLS` is merged into the new stable release, or when the rebase drops every feature commit as already upstream. A feature marked `Upstream: none` holds the retirement: the handover would drop it. With one on the branch, a release that carries every listed pull fails with a notice instead; take the merged features' commits off `fork/release` and their pulls out of `UPSTREAM_PULLS`, and the next run rebases the rest. With only such features left, the fork stays until they leave the branch: dropped by a rebase once upstream carries them, or taken off by hand. It then builds upstream's tag as it is, with upstream's update feed, signs it as above, numbers it like any fork release (`0.12.0-fork.1` on upstream `v0.12.0`) and publishes it as the fork's last release, its tag on upstream's commit. A fork app takes it because the fork signed it; that build then finds stock `0.12.0` on upstream's releases, newer than `0.12.0-fork.1`, and takes it because its requirement names upstream's team. Two updates, no hand install, and the daemon and its agents keep running. The job renames its launch agent so it does not load again and tells Tim; a failed handover is retried like any release. A pull upstream closes without merging never lands. The next run tells Tim, once per pull, and goes on releasing as before: give the feature's commit the trailer `Upstream: none` (in place of the pull's number when it carries that) and take the pull out of `UPSTREAM_PULLS`, or, when upstream carries the change in a pull of its own, put that pull in `UPSTREAM_PULLS` in its place.
