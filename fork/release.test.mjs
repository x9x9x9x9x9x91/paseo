import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  branchSpecs,
  closedPulls,
  compareStableTags,
  decide,
  deliverArgs,
  dropFromTodo,
  failureAsk,
  featureSubjects,
  forkOnlySubjects,
  forkVersion,
  liveIsOpen,
  nextForkNumber,
  nodeMajorFromWorkflow,
  parseStableTag,
  patchesDaemon,
  pathsOutsideScope,
  releaseFileNames,
  releaseFilesProblem,
  sameRequirement,
  shellLine,
  shouldSkipCandidate,
  supersededBy,
  withoutTrailers,
} from "./release.mjs";
import { FORK_IDENTITY, designatedRequirement, optionsFromPlan, signPlan } from "./sign-mac.cjs";

test("only plain vX.Y.Z tags are stable", () => {
  assert.deepEqual(parseStableTag("v0.11.4"), [0, 11, 4]);
  assert.equal(parseStableTag("v0.12.0-beta.2"), null);
  assert.equal(parseStableTag("desktop-macos-v0.12.0-beta.1"), null);
  assert.equal(parseStableTag("0.11.4-fork.1"), null);
});

test("stable tags compare numerically", () => {
  assert.ok(compareStableTags("v0.12.0", "v0.11.4") > 0);
  assert.ok(compareStableTags("v0.11.10", "v0.11.9") > 0);
  assert.equal(compareStableTags("v0.11.4", "v0.11.4"), 0);
});

test("fork builds of one upstream release count up from 1", () => {
  assert.equal(forkVersion("v0.11.4", 1), "0.11.4-fork.1");
  assert.equal(nextForkNumber("v0.11.4", []), 1);
  assert.equal(nextForkNumber("v0.11.4", ["0.11.4-fork.1", "0.11.4-fork.9", "0.11.4-fork.10"]), 11);
  assert.equal(nextForkNumber("v0.11.5", ["0.11.4-fork.3"]), 1);
  assert.equal(nextForkNumber("v0.11.4", ["0.11.40-fork.2", "0.11.4-fork.x"]), 1);
});

test("a run rebases on a newer upstream release and releases an unpublished head", () => {
  const base = { latestTag: "v0.11.4", baseTag: "v0.11.4", head: "abc" };
  assert.equal(decide({ ...base, publishedCommit: "abc" }), "current");
  assert.equal(decide({ ...base, publishedCommit: "old" }), "release");
  assert.equal(decide({ ...base, publishedCommit: null }), "release");
  assert.equal(decide({ ...base, latestTag: "v0.11.5", publishedCommit: "abc" }), "rebase");
  // upstream took its release back: the fork's release stands until upstream catches up
  assert.equal(decide({ ...base, latestTag: "v0.11.3", publishedCommit: "old" }), "current");
});

test("the fork's own commits are told apart from its features", () => {
  assert.deepEqual(
    featureSubjects([
      "feat(app): quote a selection of an agent message into the composer",
      "fork: publish desktop updates to the fork's releases",
      "fork: the release job",
    ]),
    ["feat(app): quote a selection of an agent message into the composer"],
  );
});

test("a fork release changes the app, the build config, the smoke deadline and the daemon patch only", () => {
  assert.deepEqual(
    pathsOutsideScope([
      "packages/app/src/panels/agent-panel.tsx",
      "packages/desktop/electron-builder.yml",
      "packages/desktop/e2e/packaged-app-smoke.js",
      "fork/release.mjs",
      "packages/server/src/server/agent/structured-generation-providers.ts",
      "packages/server/src/server/session.workspaces.test.ts",
      "packages/protocol/src/messages.ts",
      "packages/server/src/server/index.ts",
      "packages/server/src/server/session.test.ts",
      "packages/server/src/server/agent/agent-manager.test.ts",
      "packages/desktop/src/main.ts",
      "packages/desktop/e2e/browser-tabs.e2e.mjs",
      "package-lock.json",
    ]),
    [
      "packages/server/src/server/index.ts",
      "packages/server/src/server/agent/agent-manager.test.ts",
      "packages/desktop/src/main.ts",
      "packages/desktop/e2e/browser-tabs.e2e.mjs",
      "package-lock.json",
    ],
  );
});

const BROWSER = "packages/app/e2e/browser";

/** A throwaway repo with upstream's tag v0.11.4 on three browser specs. */
function upstreamRepo(t) {
  const repo = mkdtempSync(path.join(os.tmpdir(), "fork-specs-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => {
    const config = {
      "user.name": "fork",
      "user.email": "fork@example.invalid",
      "commit.gpgsign": "false",
      "tag.gpgsign": "false",
      "core.hooksPath": "/dev/null",
    };
    const flags = Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${value}`]);
    const result = spawnSync("git", [...flags, ...args], { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  };
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };
  git("init", "-q");
  write(`${BROWSER}/untouched.spec.ts`, "upstream's spec\n");
  write(`${BROWSER}/changed.spec.ts`, "upstream's spec, which a feature changes\n");
  write(`${BROWSER}/removed.spec.ts`, "upstream's spec, which a feature removes\n");
  commit("upstream");
  git("tag", "v0.11.4");
  return { repo, git, write, commit };
}

test("the gate runs every browser spec the branch adds or changes on upstream's tag", (t) => {
  const { repo, write, commit } = upstreamRepo(t);
  write(`${BROWSER}/changed.spec.ts`, "the feature's change\n");
  write(`${BROWSER}/added.spec.ts`, "the feature's spec\n");
  write(`${BROWSER}/added.real.spec.ts`, "a spec that needs a real provider\n");
  write("packages/app/e2e/support/helpers/added.ts", "a helper\n");
  write("packages/app/src/added.spec.ts", "a spec outside the browser folder\n");
  rmSync(path.join(repo, BROWSER, "removed.spec.ts"));
  commit("feat(app): a feature");
  assert.deepEqual(branchSpecs("v0.11.4", { cwd: repo }), [
    "e2e/browser/added.spec.ts",
    "e2e/browser/changed.spec.ts",
  ]);
});

test("a branch that changes the app with no browser spec fails, one that leaves it alone runs none", (t) => {
  const { repo, git, write, commit } = upstreamRepo(t);
  git("checkout", "-q", "-b", "app", "v0.11.4");
  write("packages/app/src/feature.tsx", "a feature with no browser spec\n");
  write(`${BROWSER}/added.real.spec.ts`, "a spec that needs a real provider\n");
  commit("feat(app): a feature");
  assert.throws(() => branchSpecs("v0.11.4", { cwd: repo }), /adds or changes no browser spec/);
  git("checkout", "-q", "-b", "daemon", "v0.11.4");
  write("packages/server/src/server/session.ts", "the daemon patch\n");
  commit("fix(server): the daemon patch");
  assert.deepEqual(branchSpecs("v0.11.4", { cwd: repo }), []);
});

test("a feature whose Upstream trailer is none is fork-only", () => {
  assert.deepEqual(
    forkOnlySubjects([
      "feat(app): quote a selection of an agent message into the composer\t",
      "fix(server): naming stays on a custom provider\tnone",
      "fork: the release job\t",
      "feat(app): another feature\tgetpaseo/paseo#9000",
      "fix(server): spelled differently\t None ",
    ]),
    ["fix(server): naming stays on a custom provider", "fix(server): spelled differently"],
  );
});

test("a pull upstream closed without merging is told once, and again only after a reopen", () => {
  const open = { state: "open", merged: false };
  const merged = { state: "closed", merged: true };
  const closed = { state: "closed", merged: false };
  assert.deepEqual(
    closedPulls([
      [7176, open],
      [7313, merged],
    ]),
    { untold: [], told: [] },
  );
  assert.deepEqual(
    closedPulls([
      [7176, open],
      [7313, closed],
    ]),
    { untold: [7313], told: [] },
  );
  assert.deepEqual(closedPulls([[7313, closed]], [7313]), { untold: [], told: [7313] });
  // a read that failed keeps what was told, and tells nothing new
  assert.deepEqual(
    closedPulls(
      [
        [7176, null],
        [7313, null],
      ],
      [7313],
    ),
    { untold: [], told: [7313] },
  );
  // reopened: forgotten, so closing it again is told again
  assert.deepEqual(closedPulls([[7313, open]], [7313]), { untold: [], told: [] });
  // a pull taken out of UPSTREAM_PULLS is not read, and drops out of what was told
  assert.deepEqual(closedPulls([[7176, open]], [7313]), { untold: [], told: [] });
});

test("a candidate is skipped after three failed runs, not before", () => {
  const failure = { candidate: "v0.11.4@abc", attempts: 2 };
  assert.equal(shouldSkipCandidate(failure, "v0.11.4@abc"), false);
  assert.equal(shouldSkipCandidate({ ...failure, attempts: 3 }, "v0.11.4@abc"), true);
  assert.equal(shouldSkipCandidate({ ...failure, attempts: 3 }, "v0.11.5@abc"), false);
  assert.equal(shouldSkipCandidate(undefined, "v0.11.4@abc"), false);
});

test("the Node major comes from upstream's release workflow", () => {
  assert.equal(
    nodeMajorFromWorkflow(
      '      - uses: actions/setup-node@v4\n        with:\n          node-version: "22"\n',
    ),
    22,
  );
  assert.equal(nodeMajorFromWorkflow("node-version: 24.1"), 24);
  assert.equal(nodeMajorFromWorkflow("no node here"), null);
});

test("the app's requirement takes Paseo's identifier from either team", () => {
  assert.equal(
    designatedRequirement("sh.paseo.desktop"),
    'designated => identifier "sh.paseo.desktop" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and (certificate leaf[subject.OU] = "HKM8HFGKC6" or certificate leaf[subject.OU] = "99ZMJMKU9Y")',
  );
});

test("the verify step reads the requirement the way codesign prints it", () => {
  // codesign -d -r- on a binary signed with designatedRequirement("sh.paseo.desktop")
  const printed =
    'designated => identifier "sh.paseo.desktop" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and (certificate leaf[subject.OU] = HKM8HFGKC6 or certificate leaf[subject.OU] = "99ZMJMKU9Y")';
  assert.ok(sameRequirement(printed, designatedRequirement("sh.paseo.desktop")));
  // the default requirement a fork build had before: the fork's team only
  const forkOnly =
    'designated => identifier "sh.paseo.desktop" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = HKM8HFGKC6';
  assert.equal(sameRequirement(forkOnly, designatedRequirement("sh.paseo.desktop")), false);
  assert.equal(sameRequirement(printed, designatedRequirement("sh.paseo.desktop.helper")), false);
});

test("a commit names the upstream pulls that replace it in its Superseded-by trailer", () => {
  assert.deepEqual(
    supersededBy([
      "aaa\tfix(server): the naming patch\tgetpaseo/paseo#7611",
      "bbb\tfeat(app): quote\t",
      "ccc\tfix(server): two replace it\tgetpaseo/paseo#1, getpaseo/paseo#2",
      "ddd\tfix(server): another repo's pull\tsomeone/else#5",
    ]),
    [
      { sha: "aaa", subject: "fix(server): the naming patch", pulls: [7611] },
      { sha: "ccc", subject: "fix(server): two replace it", pulls: [1, 2] },
    ],
  );
});

test("a commit's body loses its closing trailers and keeps the rest", () => {
  const body =
    "Upstream names on the first provider.\n\nWhen upstream carries #7611, set Host > Metadata > Manual.\n\nUpstream: none\nSuperseded-by: getpaseo/paseo#7611\n";
  assert.equal(
    withoutTrailers(body),
    "Upstream names on the first provider.\n\nWhen upstream carries #7611, set Host > Metadata > Manual.",
  );
  assert.equal(
    withoutTrailers("One paragraph: with a colon in it, and words."),
    "One paragraph: with a colon in it, and words.",
  );
});

test("the rebase todo drops the superseded commits by their abbreviated sha", () => {
  const todo =
    "pick 1a2b3c4 feat(app): quote\npick 9f8e7d6c fix(server): naming\np 5555555 fork: job\n\n# Commands:\n# p, pick <commit>";
  assert.equal(
    dropFromTodo(todo, [
      "9f8e7d6c00000000000000000000000000000000",
      "5555555aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]),
    "pick 1a2b3c4 feat(app): quote\ndrop 9f8e7d6c fix(server): naming\ndrop 5555555 fork: job\n\n# Commands:\n# p, pick <commit>",
  );
});

test("a rebase onto a newer tag leaves out a superseded commit through the job's todo editor", (t) => {
  const { repo, git, write, commit } = upstreamRepo(t);
  git("checkout", "-q", "-b", "fork", "v0.11.4");
  write("packages/app/src/quote.tsx", "quote\n");
  commit("feat(app): quote");
  write("packages/server/src/server/session.ts", "the naming patch\n");
  commit("fix(server): the naming patch");
  const patch = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).stdout.trim();
  write("fork/release.mjs", "the job\n");
  commit("fork: the job");
  git("checkout", "-q", "-b", "upstream", "v0.11.4");
  write("packages/server/src/server/other.ts", "upstream's next release\n");
  commit("upstream");
  git("tag", "v0.11.5");
  git("checkout", "-q", "fork");
  const job = fileURLToPath(new URL("./release.mjs", import.meta.url));
  const rebase = spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "rebase", "-i", "--onto", "v0.11.5", "v0.11.4"],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_SEQUENCE_EDITOR: `${shellLine([process.execPath, job])} --edit-todo`,
        PASEO_FORK_DROP: patch,
        GIT_COMMITTER_NAME: "fork",
        GIT_COMMITTER_EMAIL: "fork@example.invalid",
      },
    },
  );
  assert.equal(rebase.status, 0, rebase.stderr);
  const subjects = spawnSync("git", ["log", "--format=%s", "v0.11.5..HEAD"], {
    cwd: repo,
    encoding: "utf8",
  })
    .stdout.trim()
    .split("\n");
  assert.deepEqual(subjects, ["fork: the job", "feat(app): quote"]);
});

test("the daemon patch's tests run while the branch changes one of its files", () => {
  assert.equal(
    patchesDaemon(["packages/app/src/quote.tsx", "packages/server/src/server/session.ts"]),
    true,
  );
  // its tests alone, or the app alone, are not the patch
  assert.equal(
    patchesDaemon(["packages/server/src/server/session.test.ts", "fork/release.mjs"]),
    false,
  );
});

test("a release folder names every file the updater needs and the version in its manifest", () => {
  const names = releaseFileNames("0.12.0-fork.2");
  assert.deepEqual(names, [
    "Paseo-0.12.0-fork.2-arm64.dmg",
    "Paseo-0.12.0-fork.2-arm64.dmg.blockmap",
    "Paseo-0.12.0-fork.2-arm64.zip",
    "Paseo-0.12.0-fork.2-arm64.zip.blockmap",
    "latest-mac.yml",
  ]);
  assert.equal(
    releaseFilesProblem(
      "0.12.0-fork.2",
      [...names, "builder-debug.yml"],
      "version: 0.12.0-fork.2\nfiles:\n",
    ),
    null,
  );
  assert.match(
    releaseFilesProblem("0.12.0-fork.2", names.slice(1), "version: 0.12.0-fork.2\n"),
    /missing release files: Paseo-0.12.0-fork.2-arm64.dmg$/,
  );
  assert.match(
    releaseFilesProblem("0.12.0-fork.2", names, "version: 0.12.0-fork.1\n"),
    /does not name version 0.12.0-fork.2/,
  );
});

test("a command line for the build host keeps each word whole", () => {
  assert.equal(
    shellLine(["node", "tools/fork/release.mjs", "--build-host", "app"]),
    "'node' 'tools/fork/release.mjs' '--build-host' 'app'",
  );
  assert.equal(shellLine(["sleep 600", "it's"]), "'sleep 600' 'it'\\''s'");
});

/** A bundle laid out like the packaged app: the app, a helper app inside, a framework link. */
function fakeApp(root) {
  const app = path.join(root, "Paseo.app");
  const files = [
    "Contents/Info.plist",
    "Contents/MacOS/Paseo",
    "Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper",
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
    "Contents/Resources/app.asar",
    "Contents/PlugIns/Skipped.plugin/Contents/MacOS/Skipped",
  ];
  for (const file of files) {
    mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
    writeFileSync(path.join(app, file), file);
  }
  symlinkSync(
    "A",
    path.join(app, "Contents/Frameworks/Electron Framework.framework/Versions/Current"),
  );
  return app;
}

test("the build Mac's signing plan gives sincoder every path's options from electron-builder", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fork-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const built = fakeApp(path.join(root, "build"));
  const entitlements = path.join(root, "entitlements.mac.plist");
  const inherit = path.join(root, "entitlements.mac.inherit.plist");
  writeFileSync(entitlements, "<plist>the app's</plist>");
  writeFileSync(inherit, "<plist>inherited</plist>");
  // electron-builder's own shape: the app's entitlements on the bundle, inherited ones elsewhere
  const options = {
    app: built,
    type: "distribution",
    platform: "darwin",
    version: "44.2.0",
    ignore: (file) => file.startsWith("/Contents/PlugIns", built.length),
    optionsForFile: (file) => ({
      entitlements: file === built ? entitlements : inherit,
      hardenedRuntime: true,
      additionalArguments: [],
    }),
  };
  const plan = JSON.parse(
    JSON.stringify(signPlan(options, { identifier: "sh.paseo.desktop", osxSignVersion: "1.3.3" })),
  );
  assert.equal(plan.osxSignVersion, "1.3.3");
  assert.deepEqual(plan.ignored.sort(), [
    "Contents/PlugIns",
    "Contents/PlugIns/Skipped.plugin",
    "Contents/PlugIns/Skipped.plugin/Contents",
    "Contents/PlugIns/Skipped.plugin/Contents/MacOS",
    "Contents/PlugIns/Skipped.plugin/Contents/MacOS/Skipped",
  ]);
  // only the bundle differs from the default, so only it is listed by path
  assert.deepEqual(Object.keys(plan.byPath), [""]);

  // sincoder unpacks the same app elsewhere
  const app = fakeApp(path.join(root, "sign"));
  const files = path.join(root, "files");
  mkdirSync(files);
  const signing = optionsFromPlan(plan, app, files);
  assert.equal(signing.identity, FORK_IDENTITY);
  assert.equal(signing.version, "44.2.0");
  const own = signing.optionsForFile(app);
  assert.equal(readFileSync(own.entitlements, "utf8"), "<plist>the app's</plist>");
  assert.equal(own.requirements, `=${designatedRequirement("sh.paseo.desktop")}`);
  assert.equal(own.hardenedRuntime, true);
  const helper = signing.optionsForFile(path.join(app, "Contents/Frameworks/Paseo Helper.app"));
  assert.equal(readFileSync(helper.entitlements, "utf8"), "<plist>inherited</plist>");
  assert.equal(helper.requirements, undefined);
  assert.equal(signing.ignore(path.join(app, "Contents/PlugIns/Skipped.plugin")), true);
  assert.equal(signing.ignore(path.join(app, "Contents/MacOS/Paseo")), false);
});

test("a run waits while Ableton Live is open, by pgrep's exact process name", () => {
  const calls = [];
  const fake = (status) => (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status };
  };
  assert.equal(liveIsOpen(fake(0)), true);
  assert.equal(liveIsOpen(fake(1)), false);
  assert.deepEqual(calls[0], ["/usr/bin/pgrep", "-x", "Live"]);
});

test("a failed run's notice is an agent's ask naming job.log and the run's folder, the others are notes", () => {
  const runDir = "/x/paseo-release/runs/2026-10-26T09-32-38.733Z";
  const lint = failureAsk({ step: "lint", latestTag: "v0.13.1", runDir, jobLog: "/x/paseo-release/job.log" });
  assert.equal(
    lint,
    "Find why the fork release failed at lint from /x/paseo-release/job.log and /x/paseo-release/runs/2026-10-26T09-32-38.733Z/ and fix it on fork/release",
  );
  assert.match(
    failureAsk({ step: "rebase", latestTag: "v0.13.1", runDir }),
    /^Find why upstream v0\.13\.1 conflicts with the fork's commits from \S+job\.log and \S+\/runs\/\S+\/ and fix it on fork\/release$/,
  );
  const failed = deliverArgs({ level: "warn", title: "failed", key: "lint abc first", ask: lint });
  assert.deepEqual(failed.slice(-4), ["--needs", "agent", "--ask", lint]);
  const resolved = deliverArgs({ level: "info", title: "resolved", key: "conflict resolved abc" });
  assert.ok(!resolved.includes("--needs") && !resolved.includes("--ask"));
  assert.deepEqual(resolved.slice(0, 3), ["deliver", "--source", "paseo-fork"]);
});
