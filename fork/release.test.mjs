import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  appChanges,
  branchSpecs,
  buildArgs,
  checkoutCandidate,
  checkScope,
  closedPulls,
  CONFLICT_AGENT_TOOLS,
  compareStableTags,
  conflictAgentArgs,
  conflictPrompt,
  countFailure,
  decide,
  deliverArgs,
  dropFromTodo,
  failureNotice,
  featureSubjects,
  forkOnlySubjects,
  forkVersion,
  gateSteps,
  HERE,
  hereName,
  holdForNotary,
  liveIsOpen,
  nextForkNumber,
  nodeMajorFromWorkflow,
  notaryOutside,
  notaryRefusal,
  notaryRefused,
  onlyToolsChanged,
  OUTSIDE_STEPS,
  parseStableTag,
  pruneRuns,
  pathsOutsideScope,
  queueNotice,
  readKeptRebase,
  releaseFileNames,
  releaseFilesProblem,
  releaseKey,
  releaseNotices,
  retriedPasses,
  signedBy,
  sameRequirement,
  shellLine,
  shouldSkipCandidate,
  stageResolved,
  supersededBy,
  TOOLS_PARTS,
  topLevelParts,
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

test("a head that changes only the job's own files runs the gate once, and never on a new tag", () => {
  const base = { latestTag: "v0.11.4", baseTag: "v0.11.4", head: "abc", publishedCommit: "old" };
  assert.equal(decide({ ...base, toolsOnly: true }), "gate");
  assert.equal(decide({ ...base, toolsOnly: true, gatedCommit: "abc" }), "current");
  assert.equal(decide({ ...base, toolsOnly: true, gatedCommit: "older" }), "gate");
  assert.equal(decide({ ...base, toolsOnly: false, gatedCommit: "older" }), "release");
  assert.equal(decide({ ...base, latestTag: "v0.11.5", toolsOnly: true }), "rebase");
});

const JOB = readFileSync(fileURLToPath(new URL("./release.mjs", import.meta.url)), "utf8");

/** release.mjs with `from` replaced by `to` once, where `from` stands once. */
function jobWith(from, to, text = JOB) {
  assert.equal(text.split(from).length, 2, `once in release.mjs: ${from}`);
  return text.replace(from, to);
}

test("release.mjs reads as its declarations, every one of the job's own parts one of them", () => {
  const parts = topLevelParts(JOB);
  const declared = [...JOB.matchAll(/^(?:export )?(?:async )?(?:function|const|class) (\w+)/gm)];
  assert.deepEqual(
    declared.map(([, name]) => name).filter((name) => !parts.has(name)),
    [],
  );
  assert.deepEqual(
    [...TOOLS_PARTS].filter((name) => !parts.has(name)),
    [],
  );
  // the conflict prompt's lines in column 0 stay in its template literal
  assert.match(parts.get("conflictPrompt"), /End your reply with one line/);
  assert.deepEqual(appChanges(JOB, JOB), []);
});

test("a change to the job's own parts or comments changes no app, one to its build or release does", () => {
  const retry = jobWith(`"--retry=1"`, `"--retry=2"`);
  assert.deepEqual(appChanges(JOB, retry), []);
  const comment = jobWith("// The fork's own commits", "// The fork's very own commits");
  assert.deepEqual(appChanges(JOB, comment), []);
  const prompt = jobWith("End your reply with one line", "End your answer with one line");
  assert.deepEqual(appChanges(JOB, prompt), []);
  assert.deepEqual(
    appChanges(JOB, jobWith(`"-c.publish.channel=latest"`, `"-c.publish.channel=beta"`)),
    ["feedConfig"],
  );
  assert.deepEqual(appChanges(JOB, jobWith(`"-c.mac.identity=-"`, `"-c.mac.identity=X"`)), [
    "buildArgs",
  ]);
  assert.deepEqual(appChanges(JOB, jobWith(`"1h",`, `"2h",`)), ["notarize"]);
  // a statement that is no declaration, here an import, changes the app
  const imported = jobWith(
    `import os from "node:os";`,
    `import os from "node:os";\nimport fs from "node:fs";`,
  );
  assert.deepEqual(appChanges(JOB, imported), ['statement: import fs from "node:fs";']);
  // an app part renamed away is a change too
  const renamed = jobWith("function feedConfig(owner) {", "function updateFeed(owner) {");
  assert.ok(appChanges(JOB, renamed).includes("feedConfig"));
  // the build host's environment is the app's
  const env = jobWith("LANG=en_US.UTF-8", "LANG=C");
  assert.deepEqual(appChanges(JOB, env), ["runHostPhase"]);
});

test("a new part is the app's until the job lists it, and listing an old part lets no change pass", () => {
  const helper = jobWith(
    "function gate({ runDir, env, specs }) {",
    "function gateHelper() {\n  return 1;\n}\n\nfunction gate({ runDir, env, specs }) {",
  );
  assert.deepEqual(appChanges(JOB, helper), ["gateHelper"]);
  const list = "export const TOOLS_PARTS = new Set([";
  assert.deepEqual(appChanges(JOB, jobWith(list, `${list}\n  "gateHelper",`, helper)), []);
  const feed = jobWith(`"-c.publish.channel=latest"`, `"-c.publish.channel=beta"`);
  assert.deepEqual(appChanges(JOB, jobWith(list, `${list}\n  "feedConfig",`, feed)), [
    "feedConfig",
  ]);
  // once listed in the published text, a part is the job's own
  const listed = jobWith(list, `${list}\n  "gateHelper",`, helper);
  const changedHelper = jobWith(
    "  return 1;\n}\n\nfunction gate(",
    "  return 2;\n}\n\nfunction gate(",
    listed,
  );
  assert.deepEqual(appChanges(listed, changedHelper), []);
});

test("a backtick outside a template literal makes release.mjs a change as a whole", () => {
  const at = "function shellLine(words) {";
  const tick = jobWith(at, `${at}\n  const tick = /\x60/;`);
  assert.deepEqual(appChanges(JOB, tick), ["release.mjs, read as a whole"]);
  const escaped = jobWith(at, `${at}\n  const tick = /\\x60/;`);
  assert.deepEqual(appChanges(JOB, escaped), []);
});

test("a head ships the published app when it changes only the job's own files, release.mjs's app parts aside", (t) => {
  const { repo, write, commit } = upstreamRepo(t);
  const rev = () =>
    spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  write("packages/app/src/feature.tsx", "a feature\n");
  write("fork/release.mjs", JOB);
  write("fork/sign-mac.cjs", "the signing\n");
  write("fork/README.md", "the job\n");
  commit("feat(app): a feature, and the job");
  const published = rev();
  write("fork/README.md", "the job, said better\n");
  write("fork/release.test.mjs", "a test\n");
  write("fork/release.mjs", jobWith(`"--retry=1"`, `"--retry=2"`));
  commit("fork: the job's own files");
  const tools = rev();
  assert.equal(onlyToolsChanged(published, tools, { cwd: repo }), true);
  write("fork/release.mjs", jobWith(`"-c.publish.channel=latest"`, `"-c.publish.channel=beta"`));
  commit("fork: the update feed");
  assert.equal(onlyToolsChanged(published, rev(), { cwd: repo }), false);
  write("fork/release.mjs", JOB);
  write("fork/sign-mac.cjs", "the signing, changed\n");
  commit("fork: the signing");
  assert.equal(onlyToolsChanged(published, rev(), { cwd: repo }), false);
  write("fork/sign-mac.cjs", "the signing\n");
  write("packages/app/src/feature.tsx", "a feature, changed\n");
  commit("feat(app): the feature changed");
  assert.equal(onlyToolsChanged(published, rev(), { cwd: repo }), false);
  write("packages/app/src/feature.tsx", "a feature\n");
  write("fork/helper.mjs", "a new file of the job's\n");
  commit("fork: a new file");
  assert.equal(onlyToolsChanged(published, rev(), { cwd: repo }), false);
  assert.equal(onlyToolsChanged(published, published, { cwd: repo }), false);
  assert.equal(onlyToolsChanged(null, tools, { cwd: repo }), false);
  assert.equal(onlyToolsChanged("0".repeat(40), tools, { cwd: repo }), false);
});

test("only the newest run with heavy files keeps them, and twenty run folders stay", (t) => {
  const runs = mkdtempSync(path.join(os.tmpdir(), "fork-runs-"));
  t.after(() => rmSync(runs, { recursive: true, force: true }));
  const make = (name, files) => {
    mkdirSync(path.join(runs, name));
    writeFileSync(path.join(runs, name, "job.log"), "");
    for (const file of files) {
      if (file === "release") mkdirSync(path.join(runs, name, file));
      else writeFileSync(path.join(runs, name, file), "");
    }
  };
  const has = (name, file) => existsSync(path.join(runs, name, file));
  // two folders past twenty, a dry run, a later dry run, a real run settled, and this run
  make("2026-11-01T00-00-00", ["release"]);
  make("2026-11-01T01-00-00", []);
  for (let hour = 10; hour < 26; hour++) make(`2026-11-02T${hour}-00-00`, []);
  make("2026-11-03T00-00-00", ["release", "signed-app.zip"]);
  make("2026-11-03T01-00-00", ["release", "unsigned-app.zip", "check"]);
  make("2026-11-03T02-00-00", []);
  make("2026-11-03T03-00-00", []);
  pruneRuns(runs);
  assert.equal(readdirSync(runs).length, 20);
  assert.equal(has("2026-11-01T00-00-00", "job.log"), false);
  assert.equal(has("2026-11-03T00-00-00", "release"), false);
  assert.equal(has("2026-11-03T00-00-00", "signed-app.zip"), false);
  assert.equal(has("2026-11-03T00-00-00", "job.log"), true);
  for (const file of ["release", "unsigned-app.zip", "check", "job.log"]) {
    assert.equal(has("2026-11-03T01-00-00", file), true, file);
  }
  // a run with no heavy files leaves the last dry run's alone; one with them takes its place
  pruneRuns(runs);
  assert.equal(has("2026-11-03T01-00-00", "release"), true);
  make("2026-11-03T04-00-00", ["release"]);
  pruneRuns(runs);
  assert.equal(has("2026-11-03T01-00-00", "release"), false);
  assert.equal(has("2026-11-03T01-00-00", "unsigned-app.zip"), false);
  assert.equal(has("2026-11-03T04-00-00", "release"), true);
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

test("a fork release changes the app, the build config and the smoke deadline only", () => {
  assert.deepEqual(
    pathsOutsideScope([
      "packages/app/src/panels/agent-panel.tsx",
      "packages/desktop/electron-builder.yml",
      "packages/desktop/e2e/packaged-app-smoke.js",
      "fork/release.mjs",
      "packages/server/src/server/session.ts",
      "packages/protocol/src/messages.ts",
      "packages/server/src/server/index.ts",
      "packages/server/src/server/session.test.ts",
      "packages/server/src/server/agent/agent-manager.test.ts",
      "packages/desktop/src/main.ts",
      "packages/desktop/e2e/browser-tabs.e2e.mjs",
      "package-lock.json",
    ]),
    [
      "packages/server/src/server/session.ts",
      "packages/protocol/src/messages.ts",
      "packages/server/src/server/index.ts",
      "packages/server/src/server/session.test.ts",
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
  git("checkout", "-q", "-b", "server", "v0.11.4");
  write("packages/server/src/server/session.ts", "a server change\n");
  commit("fix(server): a server change");
  assert.deepEqual(branchSpecs("v0.11.4", { cwd: repo }), []);
});

/**
 * Sets git's default for `key` over any global config for the test, so a host's own setting cannot
 * make the read before the fix pass; `-c` still outranks it.
 */
function pinGitDefault(t, key, value) {
  const pinned = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: value };
  const saved = Object.fromEntries(Object.keys(pinned).map((name) => [name, process.env[name]]));
  Object.assign(process.env, pinned);
  t.after(() => {
    for (const [name, before] of Object.entries(saved)) {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    }
  });
}

test("the scope step reads a non-ASCII path whole, in the app or outside it", (t) => {
  pinGitDefault(t, "core.quotePath", "true");
  const { repo, write, commit } = upstreamRepo(t);
  write("packages/app/src/caf\u00e9.tsx", "an app file git would quote\n");
  commit("feat(app): a feature");
  assert.doesNotThrow(() => checkScope("v0.11.4", { cwd: repo }));
  write("packages/server/src/s\u00fc\u00df.ts", "a server file git would quote\n");
  commit("fix(server): a server change");
  assert.throws(
    () => checkScope("v0.11.4", { cwd: repo }),
    (error) => error.message.endsWith(": packages/server/src/s\u00fc\u00df.ts"),
  );
});

test("the scope step names the path a file moved into the app left", (t) => {
  pinGitDefault(t, "diff.renames", "true");
  const { repo, git, write, commit } = upstreamRepo(t);
  write("packages/server/src/server/session.ts", "upstream's server code\n");
  commit("upstream's server");
  git("tag", "v0.11.5");
  mkdirSync(path.join(repo, "packages/app/src"), { recursive: true });
  git("mv", "packages/server/src/server/session.ts", "packages/app/src/session.ts");
  commit("feat(app): the server's session, moved into the app");
  assert.throws(
    () => checkScope("v0.11.5", { cwd: repo }),
    (error) => error.message.endsWith(": packages/server/src/server/session.ts"),
  );
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

test("a failure outside the branch counts only after a day of them, the branch's own at once", () => {
  const candidate = "v0.13.2@abc";
  const hour = (h) => new Date(Date.UTC(2026, 9, 26, 10) + h * 3_600_000).toISOString();
  const outside = { candidate, outside: true };
  // GitHub or the notary down for a day: every hourly run is tried, none counted
  let failure;
  for (let h = 0; h < 24; h += 1) {
    const run = countFailure(failure, { ...outside, at: hour(h) });
    assert.equal(run.counted, false, `hour ${h}`);
    failure = run.failure;
  }
  assert.equal(failure.attempts, 0);
  assert.equal(failure.outsideSince, hour(0));
  assert.equal(shouldSkipCandidate(failure, candidate), false);
  // a fault that lasts counts from the day on, and holds the candidate three runs later
  for (let h = 24; h < 27; h += 1) {
    const run = countFailure(failure, { ...outside, at: hour(h) });
    assert.equal(run.counted, true, `hour ${h}`);
    failure = run.failure;
  }
  assert.equal(failure.attempts, 3);
  assert.equal(shouldSkipCandidate(failure, candidate), true);

  // the branch's own failure counts at once and ends a run of outside ones
  let mixed = countFailure(undefined, { ...outside, at: hour(0) }).failure;
  mixed = countFailure(mixed, { candidate, outside: false, at: hour(1) });
  assert.equal(mixed.counted, true);
  assert.equal(mixed.failure.attempts, 1);
  assert.equal(mixed.failure.outsideSince, undefined);
  const again = countFailure(mixed.failure, { ...outside, at: hour(30) });
  assert.equal(again.counted, false);
  assert.equal(again.failure.outsideSince, hour(30));

  // a new candidate starts over; a record from before outsideSince keeps its count
  const fresh = countFailure(failure, { candidate: "v0.13.2@def", outside: true, at: hour(40) });
  assert.deepEqual(fresh.failure, {
    candidate: "v0.13.2@def",
    attempts: 0,
    outsideSince: hour(40),
    at: hour(40),
  });
  const old = countFailure({ candidate, attempts: 2, step: "lint" }, { ...outside, at: hour(0) });
  assert.equal(old.failure.attempts, 2);
  assert.equal(old.counted, false);

  assert.deepEqual([...OUTSIDE_STEPS].sort(), ["github", "notarize", "publish", "push"]);
});

test("a notarize Apple answered Invalid is the app's, one the notary never finished is the notary's", () => {
  assert.equal(notaryOutside("id: 1\n  status: Invalid\n"), false);
  assert.equal(notaryOutside("id: 1\n  status: Rejected\n"), false);
  assert.equal(notaryOutside("id: 1\n  status: In Progress\nTimeout of 1h reached"), true);
  assert.equal(notaryOutside("Error: HTTP status code: 503"), true);
  assert.equal(notaryOutside(""), true);
});

const REFUSED_401 =
  "Conducting pre-submission checks for notarize.zip and initiating connection to the Apple notary service...\nError: HTTP status code: 401. Invalid credentials. Username or password is incorrect. Use the app-specific password generated at appleid.apple.com. Ensure that all authentication arguments are correct.";

test("a notary that refuses the profile's sign-in is Tim's step, never the notary down", () => {
  assert.equal(notaryRefused(REFUSED_401), true);
  assert.equal(
    notaryRefused("Error: HTTP status code: 403. A required agreement is missing"),
    true,
  );
  assert.equal(notaryRefused("Error: HTTP status code: 503"), false);
  assert.equal(notaryRefused("Error: HTTP status code: 4011"), false);
  assert.equal(notaryRefused(""), false);
  // so a 401 at notarize counts at once instead of a day of rebuilds
  assert.equal(notaryOutside(REFUSED_401), false);
  assert.equal(notaryOutside("Error: HTTP status code: 403. Forbidden"), false);
});

test("the notary is asked before the build with the job's profile; only a refusal holds the run", () => {
  const calls = [];
  const fake =
    (status, stdout, stderr = "") =>
    (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status, stdout, stderr };
    };
  assert.equal(notaryRefusal(fake(1, "", REFUSED_401)), REFUSED_401);
  assert.deepEqual(calls[0], [
    "/usr/bin/xcrun",
    "notarytool",
    "history",
    "--keychain-profile",
    "substrate-notary",
  ]);
  assert.equal(notaryRefusal(fake(0, "Successfully received submission history.")), null);
  // Apple down or no answer: the build goes ahead and its notarize step retries
  assert.equal(notaryRefusal(fake(1, "", "Error: HTTP status code: 503")), null);
  assert.equal(notaryRefusal(fake(null, "", "")), null);
  // a 401 in the history's own text with a zero exit is no refusal
  assert.equal(notaryRefusal(fake(0, "name: HTTP status code: 401")), null);
});

test("behind the release program the notary is asked by its notary-check; only Apple's refusal holds", () => {
  const program = ["sudo", "-n", "-u", "release", "/x/substrate-release"];
  const calls = [];
  const answer =
    (status, stderr = "") =>
    (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status, stdout: "", stderr };
    };
  assert.equal(notaryRefusal(answer(1, REFUSED_401), program), REFUSED_401);
  assert.deepEqual(calls[0], [...program, "notary-check"]);
  assert.equal(notaryRefusal(answer(0, "notary: Apple takes the profile"), program), null);
  // another of its steps holds the keychain: no refusal, the build goes ahead
  assert.equal(notaryRefusal(answer(75, "another step holds the hold"), program), null);
  // a refusal of sudo's or the program's own is no word of Apple's on the profile
  assert.equal(notaryRefusal(answer(1, "sudo: a password is required"), program), null);
});

test("behind the release program a refused notary login is Tim's new App Store Connect key", () => {
  const ctx = { latestTag: "v0.14.0", candidate: "v0.14.0 abc" };
  const at = "2026-10-29T13:40:00.000Z";
  const program = ["sudo", "-n", "-u", "release", "/x/substrate-release"];
  const [mini1] = holdForNotary({}, { ctx, refused: REFUSED_401, at, program }).pendingNotices;
  assert.equal(
    mini1.ask,
    "Import a new App Store Connect key into mini1's release account, so Apple's notary lets substrate-notary in and the Paseo fork builds upstream v0.14.0",
  );
  assert.match(mini1.body, /substrate-release import asc-key/);
  assert.doesNotMatch(mini1.body, /Your step: make a new app-specific password/);
  // an agreement waiting is the same step wherever the job runs
  const agreement = "Error: HTTP status code: 403. A required agreement is missing";
  const [waits] = holdForNotary({}, { ctx, refused: agreement, at, program }).pendingNotices;
  assert.match(waits.ask, /^Accept the Apple Developer agreement/);
});

test("the release program's sign gets the zip on stdin, its answer kept, its busy exit no failure", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fork-signed-by-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const program = ["sudo", "-n", "-u", "release", "/x/substrate-release"];
  const sent = path.join(root, "sent.zip");
  const back = path.join(root, "back.zip");
  writeFileSync(sent, "the unsigned app and its plan");
  const calls = [];
  const signer =
    (status, said, out = "") =>
    (cmd, args, options) => {
      calls.push({ cmd, args, stdin: readFileSync(options.stdio[0], "utf8") });
      if (out) writeFileSync(options.stdio[1], out);
      writeFileSync(options.stdio[2], said);
      return { status };
    };
  // the notary asked again after Apple took nothing: allowed unless a test says it refuses
  let refusal = () => null;
  const attempt = (spawn) => {
    const logFile = path.join(root, `sign-${calls.length}.log`);
    try {
      signedBy({ program, sent, back, logFile, spawn, refusal });
      return null;
    } catch (error) {
      return error;
    }
  };
  assert.equal(attempt(signer(0, "signed, notarized, stapled\n", "the signed app")), null);
  assert.deepEqual(calls[0], {
    cmd: "sudo",
    args: ["-n", "-u", "release", "/x/substrate-release", "sign"],
    stdin: "the unsigned app and its plan",
  });
  assert.equal(readFileSync(back, "utf8"), "the signed app");
  // busy: tried next hour, never the candidate's failure (no step)
  const busy = attempt(signer(75, "another step holds the hold\n"));
  assert.match(busy.message, /held by another of its steps/);
  assert.equal(busy.step, undefined);
  // a plan it refuses is the sign step's, counted at once
  const refused = attempt(
    signer(
      1,
      // as the program says it: the plan's line, then sign()'s own closing line
      "sign: Paseo.app as Developer ID Application: Tim Roth (HKM8HFGKC6), from its plan\nsubstrate-release: the plan asks for osx-sign 1.4.0, and 1.3.3 is pinned here\nsubstrate-release: the signing of Paseo.app failed\n",
    ),
  );
  // the program's osx-sign is pinned in Alma's repo: the signer's step, whose ask names that pin
  assert.equal(refused.step, "signer");
  assert.equal(refused.outside, false);
  assert.match(readFileSync(refused.logFile, "utf8"), /osx-sign 1\.4\.0/);
  const pinAsk = failureNotice({
    outcome: "failed",
    error: refused,
    ctx: { latestTag: "v0.17.0", head: "d975b4af3777b9c7e645b1d37a63abdcee16504e" },
    attempts: 1,
    previous: "0.16.1-fork.1",
    runDir: "/x/runs/r",
  }).ask;
  assert.match(pinAsk, /OSX_SIGN_VERSION in Alma's scripts\/agent-host\/substrate-release/);
  assert.match(pinAsk, /never a commit on fork\/release$/);
  assert.match(refused.message, /osx-sign 1\.4\.0, and 1\.3\.3 is pinned here/);
  // the program's own words (scripts/agent-host/substrate-release in Alma's repo)
  const submitted =
    "sign: Paseo.app as Developer ID Application: Tim Roth (HKM8HFGKC6), from its plan\nnotarize: submitted, waiting for Apple's verdict (up to 1 h)\n";
  const took = `${submitted}substrate-release: Apple did not accept Paseo.app: \n`;
  // the notary down or slow once asked, its profile still let in: notarize's, outside
  const down = attempt(signer(1, took));
  assert.equal(down.step, "notarize");
  assert.equal(down.outside, true);
  // the same words with the profile refused when asked again: a hold for Tim's step, never a count
  refusal = (spawn, asked) => (asked === program ? REFUSED_401 : null);
  const refusedLogin = attempt(signer(1, took));
  assert.equal(refusedLogin.step, "notary");
  assert.equal(refusedLogin.refused, REFUSED_401);
  refusal = () => null;
  // the notary rejecting the app is the candidate's
  const rejected = attempt(
    signer(
      1,
      `${submitted}substrate-release: Apple did not accept Paseo.app: "id": "a1" "status": "Invalid"\n`,
    ),
  );
  assert.equal(rejected.step, "notarize");
  assert.equal(rejected.outside, false);
  // a ticket that did not staple is Apple's, as the keychain path's stapler at notarize
  const staple = attempt(
    signer(1, `${submitted}substrate-release: the ticket did not staple onto Paseo.app\n`),
  );
  assert.equal(staple.step, "notarize");
  assert.equal(staple.outside, true);
  // Gatekeeper or codesign refusing the signed app is the candidate's, at verify
  for (const words of [
    "Gatekeeper does not accept Paseo.app",
    "Paseo.app does not verify after its signing",
  ]) {
    const refusedApp = attempt(signer(1, `${submitted}substrate-release: ${words}\n`));
    assert.equal(refusedApp.step, "verify");
    assert.equal(refusedApp.outside, false);
  }
  // the signing itself failing, before the notary, is the candidate's
  const unsigned = attempt(signer(1, "substrate-release: the signing of Paseo.app failed\n"));
  assert.equal(unsigned.step, "sign");
  assert.equal(unsigned.outside, false);
  assert.match(unsigned.message, /: substrate-release: the signing of Paseo\.app failed$/);
});

test("a notice names the Mac the job runs on, with the account when it is not the Mac's own", () => {
  assert.equal(hereName("sincoder", "sincoder"), "sincoder");
  assert.equal(hereName("alma", "mini1"), "alma@mini1");
});

test("a refused profile holds the candidate uncounted and turns its note over to Tim once", () => {
  const candidate = "v0.14.0@51c93a2d9";
  const ctx = { latestTag: "v0.14.0", candidate };
  const state = {
    lastPublished: { version: "0.13.2-fork.3", upstreamTag: "v0.13.2" },
    failure: {
      candidate,
      attempts: 1,
      outsideSince: "2026-10-29T11:26:59.423Z",
      at: "2026-10-29T12:40:37.275Z",
      step: "notarize",
    },
    openNotes: ["v0.14.0"],
  };
  const first = holdForNotary(state, { ctx, refused: REFUSED_401, at: "2026-10-29T13:40:00.000Z" });
  assert.equal(first.lastCheckAt, "2026-10-29T13:40:00.000Z");
  assert.equal(first.latestUpstream, "v0.14.0");
  // nothing counted, and the hours of the hold end the run of outside failures
  assert.deepEqual(first.failure, {
    candidate,
    attempts: 1,
    step: "notary",
    at: "2026-10-29T13:40:00.000Z",
  });
  assert.deepEqual(first.openNotes, ["v0.14.0"]);
  assert.equal(first.pendingNotices.length, 1);
  const [note] = first.pendingNotices;
  assert.equal(note.key, "release v0dot14dot0");
  assert.equal(note.standing, true);
  assert.equal(note.needs, "tim");
  assert.equal(
    note.ask,
    `Store a new app-specific password as substrate-notary on ${HERE}, so Apple's notary lets it in and the Paseo fork builds upstream v0.14.0`,
  );
  const args = deliverArgs(note);
  assert.deepEqual(args.slice(args.indexOf("--needs"), args.indexOf("--needs") + 3), [
    "--needs",
    "tim",
    "--ask",
  ]);
  assert.match(note.body, /xcrun notarytool store-credentials substrate-notary/);
  assert.match(note.body, /stays on 0\.13\.2-fork\.3/);
  assert.match(note.body, /HTTP status code: 401/);

  // the next hours leave the note his: no notice, only the check's time
  const delivered = { ...first };
  delete delivered.pendingNotices;
  const later = holdForNotary(delivered, {
    ctx,
    refused: REFUSED_401,
    at: "2026-10-29T14:40:00.000Z",
  });
  assert.equal(later.pendingNotices, undefined);
  assert.equal(later.failure.at, "2026-10-29T14:40:00.000Z");
  assert.equal(later.failure.attempts, 1);

  // a new candidate starts its own hold, and an older release's note is settled
  const next = { latestTag: "v0.14.1", candidate: "v0.14.1@abc" };
  const fresh = holdForNotary(delivered, {
    ctx: next,
    refused: REFUSED_401,
    at: "2026-10-30T09:00:00.000Z",
  });
  assert.deepEqual(fresh.failure, {
    candidate: "v0.14.1@abc",
    attempts: 0,
    step: "notary",
    at: "2026-10-30T09:00:00.000Z",
  });
  assert.deepEqual(
    fresh.pendingNotices.map((notice) => [notice.key, notice.level]),
    [
      ["release v0dot14dot0", "info"],
      ["release v0dot14dot1", "warn"],
    ],
  );
  assert.deepEqual(fresh.openNotes, ["v0.14.1"]);
  // the state it started from is left as it was
  assert.equal(state.failure.step, "notarize");
});

test("a 403 from the notary sends Tim to the developer agreement, not a new password", () => {
  const refused =
    "Error: HTTP status code: 403. A required agreement is missing or has expired. This request requires an in-effect agreement that has not been signed or has expired.";
  const held = holdForNotary(
    {},
    {
      ctx: { latestTag: "v0.14.0", candidate: "v0.14.0@abc" },
      refused,
      at: "2026-10-29T13:40:00.000Z",
    },
  );
  const [note] = held.pendingNotices;
  assert.match(note.body, /developer\.apple\.com, Account, and accept the agreement/);
  assert.doesNotMatch(note.body, /store-credentials/);
  assert.equal(note.needs, "tim");
  assert.match(note.ask, /^Accept the Apple Developer agreement at developer\.apple\.com/);
  assert.match(note.body, /stays on no fork release yet/);
  assert.match(note.body, /A required agreement is missing/);
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

test("a conflict the agent resolved stages what it left and reaches rebase --continue", (t) => {
  const { repo, git, write, commit } = upstreamRepo(t);
  const lib = "packages/app/src/lib";
  const [gone, unstaged, restaged, removed] = ["gone.test.tsx", "b.ts", "c.ts", "d.ts"].map(
    (name) => `${lib}/${name}`,
  );
  for (const file of [gone, unstaged, restaged, removed]) write(file, "upstream's\n");
  commit("upstream's files");
  git("tag", "v0.11.4a");
  git("checkout", "-q", "-b", "fork");
  for (const file of [gone, unstaged, restaged, removed]) write(file, "the fork's\n");
  commit("feat(app): the fork's change");
  git("checkout", "-q", "-b", "upstream", "v0.11.4a");
  git("rm", "-q", gone, removed);
  write(unstaged, "upstream's next\n");
  write(restaged, "upstream's next\n");
  commit("upstream's next release");
  git("tag", "v0.11.5");
  git("checkout", "-q", "fork");
  const env = {
    ...process.env,
    GIT_EDITOR: "true",
    GIT_COMMITTER_NAME: "fork",
    GIT_COMMITTER_EMAIL: "fork@example.invalid",
  };
  const rebase = spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "rebase", "--onto", "v0.11.5", "v0.11.4a"],
    { cwd: repo, encoding: "utf8", env },
  );
  assert.notEqual(rebase.status, 0, "the rebase stops on the conflicts");
  // As the agent leaves them: a modify/delete it deleted and staged, a file resolved but not
  // staged, one staged and edited again, and a modify/delete deleted on disk only.
  git("rm", "-q", gone);
  write(unstaged, "resolved\n");
  write(restaged, "resolved once\n");
  git("add", restaged);
  write(restaged, "resolved again\n");
  rmSync(path.join(repo, removed));
  assert.deepEqual(stageResolved([gone, unstaged, restaged, removed], { cwd: repo }), [
    unstaged,
    restaged,
    removed,
  ]);
  const proceed = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "rebase", "--continue"], {
    cwd: repo,
    encoding: "utf8",
    env,
  });
  assert.equal(proceed.status, 0, proceed.stderr);
  const show = (file) =>
    spawnSync("git", ["show", `HEAD:${file}`], { cwd: repo, encoding: "utf8" });
  assert.notEqual(show(gone).status, 0);
  assert.notEqual(show(removed).status, 0);
  assert.equal(show(unstaged).stdout, "resolved\n");
  assert.equal(show(restaged).stdout, "resolved again\n");
});

// One run's rebase in a child process, whose job folder (PASEO_FORK_ROOT) is the test's own. Its
// agent resolves a stop in `ports` by writing the port with the agent's run number, so a port
// made again reads differently, and answers CANNOT for a file not in `ports`.
const REBASE_RUN = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const { rebaseOnto } = await import(process.env.JOB_URL);
const { cwd, head, drop, ports, calls } = JSON.parse(process.env.RUN);
const askAgent = ({ files }) => {
  appendFileSync(calls, files.join(",") + "\\n");
  const runs = readFileSync(calls, "utf8").trim().split("\\n").length;
  if (!files.every((file) => file in ports)) return { status: 0, stdout: "CANNOT: no port" };
  for (const file of files) writeFileSync(path.join(cwd, file), ports[file] + " " + runs + "\\n");
  return { status: 0, stdout: "RESOLVED" };
};
const rebased = rebaseOnto({ newBase: "v0.11.5", oldBase: "v0.11.4", head, drop, cwd, askAgent });
// Last, on a line of its own: the job's log lines come before it.
process.stdout.write("\\n" + JSON.stringify(rebased) + "\\n");
`;

const [FIRST, SECOND] = ["packages/app/src/a.ts", "packages/app/src/b.ts"];

/**
 * A clone where upstream v0.11.5 changes a.ts and b.ts after v0.11.4, the fork branch `fork` as
 * `forkCommits` builds it on v0.11.4, and `rebase`, one run's rebaseOnto in REBASE_RUN.
 */
function keptRebaseRepo(t, forkCommits) {
  const { repo, git, write, commit } = upstreamRepo(t);
  const root = mkdtempSync(path.join(os.tmpdir(), "fork-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = path.join(root, "agent-calls");
  writeFileSync(calls, "");
  const rev = (ref) =>
    spawnSync("git", ["rev-parse", ref], { cwd: repo, encoding: "utf8" }).stdout.trim();
  const show = (ref, file) =>
    spawnSync("git", ["show", `${ref}:${file}`], { cwd: repo, encoding: "utf8" }).stdout;
  const agentRuns = () => readFileSync(calls, "utf8").split("\n").filter(Boolean);
  for (const [key, value] of [
    ["user.name", "fork"],
    ["user.email", "fork@example.invalid"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", "/dev/null"],
  ]) {
    git("config", key, value);
  }
  write(FIRST, "upstream's a\n");
  write(SECOND, "upstream's b\n");
  commit("upstream's files");
  git("tag", "-f", "v0.11.4");
  git("checkout", "-q", "-b", "fork");
  forkCommits({ git, write, commit });
  git("checkout", "-q", "-b", "upstream", "v0.11.4");
  write(FIRST, "upstream's next a\n");
  write(SECOND, "upstream's next b\n");
  commit("upstream's next release");
  git("tag", "v0.11.5");
  git("checkout", "-q", "fork");
  const spawnRebase = ({ head = rev("fork"), ports, drop = [] }) =>
    spawnSync(process.execPath, ["--input-type=module", "-e", REBASE_RUN], {
      encoding: "utf8",
      env: {
        ...process.env,
        PASEO_FORK_ROOT: root,
        JOB_URL: new URL("./release.mjs", import.meta.url).href,
        RUN: JSON.stringify({ cwd: repo, head, drop, ports, calls }),
      },
    });
  const rebase = (args) => {
    const result = spawnRebase(args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split("\n").at(-1));
  };
  return { repo, git, write, commit, rev, show, agentRuns, rebase, spawnRebase };
}

test("a rebase the agent resolved is kept, so the next run ports only the commits after it", (t) => {
  const [first, second] = [FIRST, SECOND];
  const { repo, git, write, commit, rev, show, agentRuns, rebase } = keptRebaseRepo(t, (fork) => {
    fork.write(FIRST, "the fork's a\n");
    fork.commit("feat(app): the fork's a");
    fork.write(SECOND, "the fork's b\n");
    fork.commit("feat(app): the fork's b");
  });

  // Try 1: the agent ports a, then cannot port b. The port of a is kept.
  const portA = { [first]: "the port of a" };
  assert.equal(rebase({ ports: portA }).conflict.keptUpTo, rev("fork~1"));
  assert.deepEqual(agentRuns(), [first, second]);
  const kept = readKeptRebase(repo);
  assert.equal(kept.source, rev("fork~1"));
  assert.equal(show(kept.result, first), "the port of a 1\n");

  // A fix lands on the branch; try 2 ports b and the fix's commit replays, a is not ported again.
  git("checkout", "-q", "fork");
  write("fork/release.mjs", "the job's fix\n");
  commit("fork: the job's fix");
  const ports = { ...portA, [second]: "the port of b" };
  assert.deepEqual(rebase({ ports }), { resolvedBy: "agent" });
  assert.deepEqual(agentRuns(), [first, second, second]);
  assert.equal(show("HEAD", first), "the port of a 1\n");
  assert.equal(show("HEAD", second), "the port of b 3\n");
  assert.equal(show("HEAD", "fork/release.mjs"), "the job's fix\n");
  assert.equal(kept.result, rev("HEAD~2"));
  const whole = rev("HEAD");
  assert.equal(readKeptRebase(repo).source, rev("fork"));

  // Try 3 on the same branch: the kept rebase is the candidate as it was, with no agent.
  git("checkout", "-q", "fork");
  assert.deepEqual(rebase({ ports }), { resolvedBy: "agent" });
  assert.equal(agentRuns().length, 3);
  assert.equal(rev("HEAD"), whole);

  // A branch rewritten below the kept rebase (a amended for a fresh port) rebases from scratch.
  git("checkout", "-q", "--detach", "fork~2");
  git("commit", "-q", "--amend", "-m", "feat(app): the fork's a, amended");
  git("cherry-pick", "fork~1", "fork");
  git("branch", "-f", "fork", "HEAD");
  rebase({ ports });
  assert.equal(agentRuns().length, 5);
  assert.equal(show("HEAD", first), "the port of a 4\n");
});

test("a try that stops where the kept rebase ends names that kept part for the next run", (t) => {
  const { repo, rev, agentRuns, rebase } = keptRebaseRepo(t, ({ write, commit }) => {
    write(FIRST, "the fork's a\n");
    commit("feat(app): the fork's a");
    write(SECOND, "the fork's b\n");
    commit("feat(app): the fork's b");
  });
  const portA = { [FIRST]: "the port of a" };
  assert.equal(rebase({ ports: portA }).conflict.keptUpTo, rev("fork~1"));
  const kept = readKeptRebase(repo);
  // Try 2 starts from the kept part and stops on b again, so it keeps nothing new of its own.
  assert.equal(rebase({ ports: portA }).conflict.keptUpTo, rev("fork~1"));
  assert.deepEqual(agentRuns(), [FIRST, SECOND, SECOND]);
  assert.deepEqual(readKeptRebase(repo), kept);
});

test("a rebase that fails before it stops is a failed step, with nothing kept as done", (t) => {
  const { repo, git, agentRuns, spawnRebase } = keptRebaseRepo(t, ({ write, commit }) => {
    write(FIRST, "the fork's a\n");
    commit("feat(app): the fork's a");
  });
  // A pre-rebase hook that refuses makes git rebase fail with no rebase in progress.
  const hooks = path.join(repo, ".git", "refusing-hooks");
  mkdirSync(hooks);
  writeFileSync(path.join(hooks, "pre-rebase"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  git("config", "core.hooksPath", hooks);
  const result = spawnRebase({ ports: {} });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /the rebase from v0\.11\.4 toward v0\.11\.5 failed without stopping on a commit/,
  );
  assert.deepEqual(agentRuns(), []);
  assert.equal(readKeptRebase(repo), null);
});

test("a kept rebase leaves out the same superseded commits, and a changed set ports afresh", (t) => {
  const [superseded, later] = ["packages/app/src/superseded.ts", "packages/app/src/later.ts"];
  const { repo, rev, show, agentRuns, rebase } = keptRebaseRepo(t, ({ write, commit }) => {
    write(FIRST, "the fork's a\n");
    commit("feat(app): the fork's a");
    write(superseded, "a feature upstream replaced\n");
    commit("feat(app): a feature upstream replaced");
    write(SECOND, "the fork's b\n");
    commit("feat(app): the fork's b");
    write(later, "a later feature upstream replaced\n");
    commit("feat(app): a later feature upstream replaced");
  });
  const drop = [rev("fork~2"), rev("fork")];
  const portA = { [FIRST]: "the port of a" };
  const ports = { ...portA, [SECOND]: "the port of b" };

  // Try 1 drops the first superseded commit and stops on b: the kept part runs through it.
  assert.ok(rebase({ ports: portA, drop }).conflict);
  assert.deepEqual(readKeptRebase(repo).drop, [rev("fork~2")]);
  assert.equal(readKeptRebase(repo).source, rev("fork~2"));

  // Try 2, the same commits superseded: only b is ported, and the replay's todo drops the later.
  assert.deepEqual(rebase({ ports, drop }), { resolvedBy: "agent" });
  assert.deepEqual(agentRuns(), [FIRST, SECOND, SECOND]);
  assert.equal(show("HEAD", FIRST), "the port of a 1\n");
  assert.equal(show("HEAD", SECOND), "the port of b 3\n");
  assert.equal(show("HEAD", superseded), "");
  assert.equal(show("HEAD", later), "");

  // Try 3, the commit no longer superseded: the kept rebase does not hold, and both are ported.
  rebase({ ports });
  assert.equal(agentRuns().length, 5);
  assert.equal(show("HEAD", superseded), "a feature upstream replaced\n");
  assert.equal(show("HEAD", later), "a later feature upstream replaced\n");
  assert.deepEqual(readKeptRebase(repo).drop, []);
});

test("a branch with a merge keeps no part of a stopped rebase, and keeps a whole one", (t) => {
  const { repo, rev, agentRuns, rebase } = keptRebaseRepo(t, ({ git, write, commit }) => {
    git("checkout", "-q", "-b", "side");
    write("fork/side.mjs", "a side branch\n");
    commit("fork: a side branch");
    git("checkout", "-q", "fork");
    write("fork/main.mjs", "the branch\n");
    commit("fork: the branch");
    git("merge", "-q", "--no-ff", "-m", "fork: merge the side branch", "side");
    write(SECOND, "the fork's b\n");
    commit("feat(app): the fork's b");
  });
  // The stop on b comes after the replayed commits, whose order a merge leaves to git.
  assert.equal(rebase({ ports: {} }).conflict.keptUpTo, null);
  assert.equal(agentRuns().length, 1);
  assert.equal(readKeptRebase(repo), null);
  assert.deepEqual(rebase({ ports: { [SECOND]: "the port of b" } }), { resolvedBy: "agent" });
  assert.equal(readKeptRebase(repo).source, rev("fork"));
});

// One build host's formatPort in a child process, whose job folder (PASEO_FORK_ROOT) is the
// test's own: its formatter writes `rewrites`, each file's text as the formatter would leave it.
const FORMAT_RUN = `
import { writeFileSync } from "node:fs";
import path from "node:path";
const { formatPort } = await import(process.env.JOB_URL);
const { cwd, rewrites } = JSON.parse(process.env.RUN);
const format = () => {
  for (const [file, text] of Object.entries(rewrites)) writeFileSync(path.join(cwd, file), text);
};
process.stdout.write("\\n" + formatPort("v0.11.4", { cwd, format }) + "\\n");
`;

function formatRepo(t) {
  const { repo, git, write, commit } = upstreamRepo(t);
  write(FIRST, "upstream's a\n");
  write(SECOND, "upstream's b\n");
  write("packages/app/src/upstreams.ts", "upstream's own file\n");
  commit("upstream's files");
  git("tag", "-f", "v0.11.4");
  const out = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" }).stdout.trimEnd();
  const root = mkdtempSync(path.join(os.tmpdir(), "fork-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tryFormat = (rewrites) =>
    spawnSync(process.execPath, ["--input-type=module", "-e", FORMAT_RUN], {
      encoding: "utf8",
      env: {
        ...process.env,
        PASEO_FORK_ROOT: root,
        JOB_URL: new URL("./release.mjs", import.meta.url).href,
        RUN: JSON.stringify({ cwd: repo, rewrites }),
      },
    });
  const formatPort = (rewrites) => {
    const result = tryFormat(rewrites);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split("\n").at(-1);
  };
  return { repo, git, write, commit, out, formatPort, tryFormat };
}

test("a port the formatter rewrites is folded into the last commit that changes each file", (t) => {
  const { write, commit, out, formatPort } = formatRepo(t);
  write(FIRST, "the fork's a,  as the agent left it\n");
  write(SECOND, "the fork's b,  as the agent left it\n");
  commit("feat(app): the fork's a and b");
  write(FIRST, "the fork's next a,  as the agent left it\n");
  commit("fix(app): the fork's next a");
  const subjects = out("log", "--format=%s %an", "v0.11.4..HEAD");
  const head = formatPort({
    [FIRST]: "the fork's next a, formatted\n",
    [SECOND]: "the fork's b, formatted\n",
    "packages/app/src/upstreams.ts": "upstream's own file, which the check judges as it is\n",
  });
  assert.equal(out("rev-parse", "HEAD"), head);
  assert.equal(out("log", "--format=%s %an", "v0.11.4..HEAD"), subjects);
  assert.equal(out("status", "--porcelain"), "");
  assert.equal(out("show", "HEAD~1:" + SECOND), "the fork's b, formatted");
  assert.equal(out("show", "HEAD~1:" + FIRST), "the fork's a,  as the agent left it");
  assert.equal(out("show", "HEAD:" + FIRST), "the fork's next a, formatted");
  assert.equal(out("show", "HEAD:packages/app/src/upstreams.ts"), "upstream's own file");
});

test("a commit whose whole change the formatter undoes leaves the port, a bracketed path folds", (t) => {
  const { write, commit, out, formatPort } = formatRepo(t);
  const bracketed = "packages/app/src/[id]/c.ts";
  // As a glob, the bracketed path names this one too, which a later commit changes.
  const sibling = "packages/app/src/i/c.ts";
  write(FIRST, "upstream's a \n");
  commit("fix(app): a's spacing, as the agent left it");
  write(SECOND, "the fork's b\n");
  write(bracketed, "the fork's c,  as the agent left it\n");
  commit("feat(app): the fork's b and c");
  write(sibling, "the fork's i\n");
  commit("feat(app): the fork's i");
  const head = formatPort({
    [FIRST]: "upstream's a\n",
    [bracketed]: "the fork's c, formatted\n",
  });
  assert.equal(out("rev-parse", "HEAD"), head);
  assert.equal(
    out("log", "--format=%s", "v0.11.4..HEAD"),
    "feat(app): the fork's i\nfeat(app): the fork's b and c",
  );
  assert.equal(out("status", "--porcelain"), "");
  assert.equal(out("show", "HEAD:" + FIRST), "upstream's a");
  assert.equal(out("show", "HEAD~1:" + bracketed), "the fork's c, formatted");
  assert.equal(out("diff", "--name-only", "HEAD~1", "HEAD"), sibling);
});

test("a file a commit of the port renames folds into that commit", (t) => {
  const { git, write, commit, out, formatPort } = formatRepo(t);
  const renamed = "packages/app/src/renamed.ts";
  git("mv", FIRST, renamed);
  commit("refactor(app): a renamed");
  write(SECOND, "the fork's b\n");
  commit("feat(app): the fork's b");
  const head = formatPort({ [renamed]: "upstream's a, formatted\n" });
  assert.equal(out("rev-parse", "HEAD"), head);
  assert.equal(
    out("log", "--format=%s", "v0.11.4..HEAD"),
    "feat(app): the fork's b\nrefactor(app): a renamed",
  );
  assert.equal(out("status", "--porcelain"), "");
  assert.equal(out("show", "HEAD~1:" + renamed), "upstream's a, formatted");
  assert.equal(out("ls-tree", "--name-only", "HEAD~1", "--", FIRST), "");
  assert.equal(out("diff", "--name-only", "HEAD~1", "HEAD"), SECOND);
});

test("a path with a space or a leading colon folds into its own commit", (t) => {
  const { write, commit, out, formatPort } = formatRepo(t);
  const spaced = "packages/app/src/a b.ts";
  // As a pathspec, ":x.ts" is the plain x.ts, which a later commit changes.
  write(spaced, "the fork's a b,  as the agent left it\n");
  write(":x.ts", "the fork's :x,  as the agent left it\n");
  commit("feat(app): the fork's a b and :x");
  write("x.ts", "the fork's x\n");
  commit("feat(app): the fork's x");
  const head = formatPort({
    [spaced]: "the fork's a b, formatted\n",
    ":x.ts": "the fork's :x, formatted\n",
  });
  assert.equal(out("rev-parse", "HEAD"), head);
  assert.equal(
    out("log", "--format=%s", "v0.11.4..HEAD"),
    "feat(app): the fork's x\nfeat(app): the fork's a b and :x",
  );
  assert.equal(out("status", "--porcelain"), "");
  assert.equal(out("show", "HEAD~1:" + spaced), "the fork's a b, formatted");
  assert.equal(out("show", "HEAD~1::x.ts"), "the fork's :x, formatted");
  assert.equal(out("diff", "--name-only", "HEAD~1", "HEAD"), "x.ts");
});

// A port with a merge, which the fold's rebase lays out flat: `side` and the branch both change
// SECOND, and `merge` makes the merge commit, `extra` a change of the merge's own.
function mergedPort({ repo, git, write, commit }, { extra = null } = {}) {
  write(FIRST, "the fork's a,  as the agent left it\n");
  commit("feat(app): the fork's a");
  git("checkout", "-q", "-b", "side", "v0.11.4");
  write(SECOND, "the side's b\n");
  commit("feat(app): the side's b");
  git("checkout", "-q", "-");
  if (extra) {
    git("merge", "-q", "--no-ff", "--no-commit", "side");
    write(extra, "the merge's own change\n");
    commit("Merge the side");
  } else {
    write(SECOND, "the branch's b\n");
    commit("feat(app): the branch's b");
    const merged = spawnSync("git", ["merge", "-q", "--no-ff", "--no-commit", "side"], {
      cwd: repo,
    });
    assert.notEqual(merged.status, 0, "the side's b conflicts with the branch's");
    write(SECOND, "the branch's and the side's b\n");
    commit("Merge the side");
  }
}

test("a fold whose rebase stops is aborted, the clone left clean", (t) => {
  const fixture = formatRepo(t);
  const { repo, out, tryFormat } = fixture;
  mergedPort(fixture);
  const before = out("rev-parse", "HEAD");
  const result = tryFormat({ [FIRST]: "the fork's a, formatted\n" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /folding the formatter's rewrite of packages\/app\/src\/a\.ts/);
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    assert.equal(existsSync(path.join(repo, ".git", dir)), false, `${dir} is left`);
  }
  assert.equal(out("status", "--porcelain"), "");
  assert.equal(out("rev-parse", "HEAD~1"), before);
  assert.equal(out("show", "HEAD:" + FIRST), "the fork's a, formatted");
});

test("a fold that loses a change of the port fails the step", (t) => {
  const fixture = formatRepo(t);
  const { out, tryFormat } = fixture;
  mergedPort(fixture, { extra: "packages/app/src/merged.ts" });
  const result = tryFormat({ [FIRST]: "the fork's a, formatted\n" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /the folded port is not the formatted tree/);
  assert.equal(out("ls-tree", "--name-only", "HEAD", "--", "packages/app/src/merged.ts"), "");
});

// The signing Mac's takeFormattedPort in a child process, its job folder the test's own.
const TAKE_RUN = `
const { takeFormattedPort } = await import(process.env.JOB_URL);
const { head, runDir, formatOnto = "v0.11.4" } = JSON.parse(process.env.RUN);
const before = ["the features before the fold"];
const features = takeFormattedPort({ ctx: { host: "build-host" }, formatOnto, head, features: before, runDir });
process.stdout.write("\\n" + JSON.stringify({ features, same: features === before }) + "\\n");
`;

// What the build host's app half runs, as a fixture's own package scripts: npm ci leaves electron's
// installer and playwright, the formatter writes the port's formatted text, the gate's format
// check copies the text of a it checked to FIXTURE_GATE_SAW, the build copies the text of a it
// built into its signing plan, and every other check passes.
const HOST_SCRIPTS = {
  "package.json": `${JSON.stringify({
    name: "fixture",
    private: true,
    workspaces: ["packages/app", "packages/expo-two-way-audio"],
    scripts: {
      format: "node scripts/format.mjs",
      "format:check": "node scripts/gate.mjs",
      lint: "true",
      "build:server": "true",
      typecheck: "true",
      "build:app-deps": "true",
      "build:desktop": "node scripts/build.mjs",
    },
  })}\n`,
  ".gitignore": "node_modules/\npackages/desktop/release/\n",
  "packages/app/package.json": `${JSON.stringify({ name: "@getpaseo/app", scripts: { test: "true" } })}\n`,
  "packages/expo-two-way-audio/package.json": `${JSON.stringify({
    name: "@getpaseo/expo-two-way-audio",
    scripts: { build: "true" },
  })}\n`,
  "packages/desktop/package.json": `${JSON.stringify({ name: "desktop", version: "0.11.4" })}\n`,
  "fork/release.test.mjs": `import { test } from "node:test";
test("the fixture's release tests", () => {});
`,
  "scripts/npm-retry.mjs": `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("node_modules/electron", { recursive: true });
writeFileSync("node_modules/electron/install.js", "");
mkdirSync("node_modules/.bin", { recursive: true });
writeFileSync("node_modules/.bin/playwright", "#!/bin/sh\\nexit 0\\n", { mode: 0o755 });
`,
  "scripts/format.mjs": `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(FIRST)}, "the fork's a, formatted\\n");
writeFileSync(${JSON.stringify(SECOND)}, "upstream's b\\n");
`,
  "scripts/gate.mjs": `import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(process.env.FIXTURE_GATE_SAW, readFileSync(${JSON.stringify(FIRST)}, "utf8"));
`,
  "scripts/build.mjs": `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const a = readFileSync(${JSON.stringify(FIRST)}, "utf8");
writeFileSync(process.env.PASEO_FORK_SIGN_PLAN, JSON.stringify({ a }) + "\\n");
mkdirSync("packages/desktop/release/mac-arm64/Paseo.app", { recursive: true });
`,
};

test("the port the build host formats is the head the signing Mac takes and pushes", (t) => {
  const { repo, git, write, commit, out } = formatRepo(t);
  for (const [file, text] of Object.entries(HOST_SCRIPTS)) write(file, text);
  commit("upstream's scripts");
  git("tag", "-f", "v0.11.4");
  write(FIRST, "the fork's a,  as the agent left it\n");
  commit("feat(app): the fork's a");
  write(SECOND, "upstream's b \n");
  commit("fix(app): b's spacing, as the agent left it");
  write("fork/job.mjs", "the job\n");
  commit("fork: the job's own file");
  const candidate = out("rev-parse", "HEAD");
  git("update-ref", "refs/heads/fork-candidate", candidate);
  const scratch = mkdtempSync(path.join(os.tmpdir(), "fork-hosts-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const hostRoot = path.join(scratch, "host");
  const signRoot = path.join(scratch, "sign");
  const runName = "2026-11-22T03-00-00";
  mkdirSync(path.join(hostRoot, "runs", runName), { recursive: true });
  mkdirSync(path.join(signRoot, "runs", runName), { recursive: true });
  symlinkSync(repo, path.join(hostRoot, "build"));
  // The signing Mac's clone stands at the candidate it sent, as the formatter left it alone.
  const cloned = spawnSync("git", ["clone", "-q", repo, path.join(signRoot, "build")]);
  assert.equal(cloned.status, 0, String(cloned.stderr));
  const job = { version: "0.11.4-fork.1", owner: "fork", nodeMajor: 22, checks: { specs: [] } };
  writeFileSync(
    path.join(hostRoot, "runs", runName, "host-job.json"),
    JSON.stringify({ ...job, formatOnto: "v0.11.4" }),
  );
  // brew, ditto and ssh stand in for the Mac's own; the host's home holds its job folder.
  const bin = path.join(scratch, "bin");
  const home = path.join(scratch, "home");
  mkdirSync(bin);
  mkdirSync(path.join(home, "Coding/_forks"), { recursive: true });
  symlinkSync(hostRoot, path.join(home, "Coding/_forks/paseo-release"));
  writeFileSync(path.join(bin, "brew"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(path.join(bin, "ditto"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const fakeSsh = path.join(bin, "fake-ssh");
  writeFileSync(
    fakeSsh,
    [
      "#!/bin/sh",
      "for last; do :; done",
      'cd "$FAKE_HOME" || exit 1',
      'case "$last" in',
      '  "git-upload-pack "*) eval "exec git upload-pack ${last#git-upload-pack }" ;;',
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const jobUrl = new URL("./release.mjs", import.meta.url);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const gateSaw = path.join(scratch, "gate-saw");
  const host = spawnSync(
    process.execPath,
    [fileURLToPath(jobUrl), "--build-host", "app", runName],
    { encoding: "utf8", env: { ...env, PASEO_FORK_ROOT: hostRoot, FIXTURE_GATE_SAW: gateSaw } },
  );
  const resultFile = path.join(hostRoot, "runs", runName, "host-result-app.json");
  const result = JSON.parse(readFileSync(resultFile, "utf8"));
  assert.equal(host.status, 0, `${host.stdout}${host.stderr}${JSON.stringify(result)}`);
  assert.equal(result.ok, true);
  assert.notEqual(result.head, candidate);
  assert.equal(out("rev-parse", "refs/heads/fork-formatted"), result.head);
  assert.equal(
    out("log", "--format=%s", `v0.11.4..${result.head}`),
    "fork: the job's own file\nfeat(app): the fork's a",
  );
  assert.equal(out("show", `${result.head}:${FIRST}`), "the fork's a, formatted");
  assert.equal(out("show", `${result.head}:${SECOND}`), "upstream's b");
  // The gate checks and the build builds the formatted tree, which hostPhase formats first.
  assert.equal(readFileSync(gateSaw, "utf8"), "the fork's a, formatted\n");
  const plan = JSON.parse(readFileSync(path.join(hostRoot, "runs", runName, "sign-plan.json")));
  assert.equal(plan.a, "the fork's a, formatted\n");
  const sign = spawnSync(process.execPath, ["--input-type=module", "-e", TAKE_RUN], {
    encoding: "utf8",
    env: {
      ...env,
      PASEO_FORK_ROOT: signRoot,
      JOB_URL: jobUrl.href,
      RUN: JSON.stringify({ head: result.head, runDir: path.join(signRoot, "runs", runName) }),
      GIT_SSH_COMMAND: fakeSsh,
      GIT_SSH_VARIANT: "simple",
      FAKE_HOME: home,
    },
  });
  assert.equal(sign.status, 0, `${sign.stdout}${sign.stderr}`);
  // release() pushes and tags HEAD: the head the build host checked, built and formatted.
  assert.deepEqual(JSON.parse(sign.stdout.trim().split("\n").at(-1)).features, [
    "feat(app): the fork's a",
  ]);
  const signing = (...args) =>
    spawnSync("git", args, { cwd: path.join(signRoot, "build"), encoding: "utf8" }).stdout.trim();
  assert.equal(signing("rev-parse", "HEAD"), result.head);
  assert.equal(signing("status", "--porcelain"), "");
});

test("the signing Mac fetches no port when there is none or it already stands at it", (t) => {
  const { repo, write, commit, out } = formatRepo(t);
  write(FIRST, "the fork's a\n");
  commit("feat(app): the fork's a");
  const scratch = mkdtempSync(path.join(os.tmpdir(), "fork-hosts-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const signRoot = path.join(scratch, "sign");
  const runDir = path.join(signRoot, "runs", "2026-11-22T03-00-00");
  mkdirSync(runDir, { recursive: true });
  const cloned = spawnSync("git", ["clone", "-q", repo, path.join(signRoot, "build")]);
  assert.equal(cloned.status, 0, String(cloned.stderr));
  const signing = (...args) =>
    spawnSync("git", args, { cwd: path.join(signRoot, "build"), encoding: "utf8" }).stdout.trim();
  const head = signing("rev-parse", "HEAD");
  // Any ssh, the build host's fetch's too, leaves a mark and fails.
  const called = path.join(scratch, "ssh-called");
  const failSsh = path.join(scratch, "fail-ssh");
  writeFileSync(failSsh, `#!/bin/sh\necho "$@" >> "${called}"\nexit 1\n`, { mode: 0o755 });
  const take = (formatOnto, portHead) =>
    spawnSync(process.execPath, ["--input-type=module", "-e", TAKE_RUN], {
      encoding: "utf8",
      env: {
        ...process.env,
        PASEO_FORK_ROOT: signRoot,
        JOB_URL: new URL("./release.mjs", import.meta.url).href,
        RUN: JSON.stringify({ head: portHead, runDir, formatOnto }),
        GIT_SSH_COMMAND: failSsh,
        GIT_SSH_VARIANT: "simple",
      },
    });
  const other = out("rev-parse", "HEAD~1");
  for (const [formatOnto, portHead] of [
    [null, other],
    ["v0.11.4", head],
    ["v0.11.4", null],
  ]) {
    const sign = take(formatOnto, portHead);
    assert.equal(sign.status, 0, `${sign.stdout}${sign.stderr}`);
    assert.deepEqual(JSON.parse(sign.stdout.trim().split("\n").at(-1)), {
      features: ["the features before the fold"],
      same: true,
    });
    assert.equal(signing("rev-parse", "HEAD"), head);
    assert.equal(signing("for-each-ref", "refs/heads/fork-formatted"), "");
  }
  assert.equal(existsSync(called), false);
});

test("a port the formatter leaves alone keeps its head", (t) => {
  const { write, commit, out, formatPort } = formatRepo(t);
  write(FIRST, "the fork's a\n");
  commit("feat(app): the fork's a");
  const before = out("rev-parse", "HEAD");
  assert.equal(formatPort({ [FIRST]: "the fork's a\n" }), before);
  assert.equal(out("rev-parse", "HEAD"), before);
});

test("the conflict agent may git rm a file upstream deleted, and its prompt says to", () => {
  const tools = CONFLICT_AGENT_TOOLS.split(",");
  assert.ok(tools.includes("Bash(git rm:*)"));
  assert.ok(tools.includes("Bash(git add:*)"));
  assert.ok(!tools.some((tool) => /git (commit|rebase|reset|checkout)/.test(tool)));
  const stop = {
    commit: "6827d2572",
    oldBase: "v0.15.0",
    newBase: "v0.16.0",
    files: ["packages/app/src/lib/overlay-root.test.tsx"],
  };
  const prompt = conflictPrompt(stop);
  const args = conflictAgentArgs(stop);
  assert.equal(args[args.indexOf("--allowedTools") + 1], CONFLICT_AGENT_TOOLS);
  assert.equal(args[args.indexOf("-p") + 1], prompt);
  assert.match(prompt, /- packages\/app\/src\/lib\/overlay-root\.test\.tsx/);
  assert.match(prompt, /upstream deleted is resolved with git rm <file> \(never --cached/);
});

test("the build host checks out the candidate without the last build's ignored files", (t) => {
  const { repo, git, write, commit } = upstreamRepo(t);
  const routes = "packages/app/.expo/types/router.d.ts";
  write(".gitignore", ".expo/\nnode_modules/\ndist/\n");
  write("packages/app/src/routes.ts", "the candidate's routes\n");
  commit("the candidate");
  git("branch", "fork-candidate");
  // As the last build left the checkout: its generated routes, deps and output, a stray file
  // and a tracked file edited in place.
  write(routes, "the previous version's routes\n");
  write("node_modules/dep/index.js", "dep\n");
  write("packages/app/dist/index.html", "built\n");
  write("stray.txt", "left over\n");
  write("packages/app/src/routes.ts", "edited by a step\n");
  checkoutCandidate({ cwd: repo });
  const status = spawnSync("git", ["status", "--porcelain", "--ignored"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(status.stdout, "");
  const head = (ref) =>
    spawnSync("git", ["rev-parse", ref], { cwd: repo, encoding: "utf8" }).stdout.trim();
  assert.equal(head("HEAD"), head("fork-candidate"));
  assert.equal(
    readFileSync(path.join(repo, "packages/app/src/routes.ts"), "utf8"),
    "the candidate's routes\n",
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

test("the build hands electron-builder the signing hook and the ad-hoc identity", () => {
  // electron-builder 26.18.0 calls mac.sign only once it has an identity; the build host has none.
  const args = buildArgs("someone");
  const config = args.filter((arg) => arg.startsWith("-c.mac."));
  assert.deepEqual(config, [
    `-c.mac.sign=${path.join(path.dirname(fileURLToPath(import.meta.url)), "sign-mac.cjs")}`,
    "-c.mac.identity=-",
    "-c.mac.notarize=false",
  ]);
  assert.deepEqual(args.slice(0, 3), ["run", "build:desktop", "--"]);
  assert.ok(args.includes("-c.publish.owner=someone"));
  assert.deepEqual(args.slice(args.indexOf("--mac"), args.indexOf("--mac") + 3), [
    "--mac",
    "zip",
    "--arm64",
  ]);
});

test("the app's unit tests try a failed test once more, and the e2e step runs only the branch's specs", () => {
  const byStep = (specs) =>
    Object.fromEntries(gateSteps(specs).map(([step, ...rest]) => [step, rest]));
  const withSpecs = byStep(["e2e/browser/a.spec.ts"]);
  assert.deepEqual(withSpecs["app-unit"], [
    "npm",
    ["run", "test", "--workspace=@getpaseo/app", "--", "--retry=1", "--reporter=verbose"],
  ]);
  assert.deepEqual(withSpecs.e2e, [
    "npm",
    ["run", "test:e2e", "--workspace=@getpaseo/app", "--", "e2e/browser/a.spec.ts"],
  ]);
  assert.equal(gateSteps([]).at(-1)[0], "two-way-audio");
  assert.equal(byStep([]).e2e, undefined);
});

test("the app-unit step's log names the tests that passed only on their retry", () => {
  const stepLog = [
    "$ npm run test --workspace=@getpaseo/app -- --retry=1 --reporter=verbose",
    " \u001b[32m✓\u001b[39m \u001b[30m unit \u001b[39m src/a.test.ts:3:1 > a > passes 2ms",
    " \u001b[32m✓\u001b[39m  browser (chromium)  src/b.browser.test.tsx:9:3 > b > drops 150ms\u001b[33m (retry x1)\u001b[39m",
    " \u001b[31m×\u001b[39m  unit  src/c.test.ts:5:1 > c > fails twice 3ms\u001b[33m (retry x1)\u001b[39m",
    "exit=0",
  ].join("\n");
  assert.deepEqual(retriedPasses(stepLog), [
    "browser (chromium)  src/b.browser.test.tsx:9:3 > b > drops 150ms (retry x1)",
  ]);
  assert.deepEqual(retriedPasses("exit=0\n"), []);
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

test("the build Mac's signing plan gives the signing Mac every path's options from electron-builder", (t) => {
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
  // the bundle's own entry carries the two-team requirement, for a signer that adds none
  const bundle = plan.options[plan.byPath[""]];
  assert.equal(bundle.requirements, `=${designatedRequirement("sh.paseo.desktop")}`);
  assert.equal(plan.options[plan.defaultIndex].requirements, undefined);

  // the signing Mac unpacks the same app elsewhere
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

test("a failed run's notice is an agent's ask naming job.log and the runs folder, one line per candidate", () => {
  const ctx = {
    latestTag: "v0.13.1",
    head: "d975b4af3777b9c7e645b1d37a63abdcee16504e",
    conflict: { files: ["packages/app/a.tsx"], diff: "<<<<<<<" },
  };
  const paths = { jobLog: "/x/paseo-release/job.log", runs: "/x/paseo-release/runs" };
  const notice = (outcome, error, attempts, run) =>
    failureNotice({
      outcome,
      error,
      ctx,
      attempts,
      previous: "0.12.0-fork.2",
      runDir: `/x/paseo-release/runs/${run}`,
      ...paths,
    });
  const lint = { step: "lint", message: "lint failed" };
  const first = notice("failed", lint, 1, "2026-10-26T09-32-38.733Z");
  const last = notice("failed", lint, 3, "2026-10-26T11-35-02.104Z");
  assert.equal(first.step, "lint");
  assert.equal(
    first.ask,
    "Find why the fork release failed at lint for upstream v0.13.1 with branch d975b4af3 from /x/paseo-release/job.log and the run folder under /x/paseo-release/runs/ this notice names, and fix it on fork/release",
  );
  // The night run groups asks by their line: a candidate's first and last notice are one subject.
  assert.equal(last.ask, first.ask);
  // A refusal at notarize itself is Tim's step, never a fix on the branch.
  const refused = notice(
    "failed",
    {
      step: "notarize",
      message:
        "Apple did not accept the app (exit 1):\nError: HTTP status code: 401. Invalid credentials.",
    },
    1,
    "2026-10-26T12-00-00.000Z",
  );
  assert.match(refused.ask, /^Find why Apple's notary refused substrate-notary at notarize/);
  assert.match(
    refused.ask,
    /is Tim's step .* needs no fix on fork\/release, so name it as his step$/,
  );
  assert.ok(
    first.body.includes(`Run log: /x/paseo-release/runs/2026-10-26T09-32-38.733Z on ${HERE}.`),
    first.body,
  );
  assert.match(last.body, /attempt 3 of 3/);
  assert.ok(!first.ask.includes("\n"));

  const conflict = notice("conflict", undefined, 1, "r");
  assert.equal(conflict.step, "rebase");
  assert.match(
    conflict.ask,
    /^Find why upstream v0\.13\.1 conflicts with the fork's commits on branch d975b4af3 from \/x\/paseo-release\/job\.log /,
  );
  assert.match(conflict.body, /conflicted in packages\/app\/a\.tsx/);
  // A conflict is a counted try like any failure, and the next run starts from the kept rebase.
  assert.match(
    conflict.body,
    /This was attempt 1 of 3 for upstream v0\.13\.1 with branch d975b4af3: the job's next run on v0\.13\.1 rebases again from the start; after attempt 3 the job waits/,
  );
  ctx.conflict.keptUpTo = "6827d2572f0e5c1a9b3d4e7f8a0b1c2d3e4f5a6b";
  const keptTry = notice("conflict", undefined, 2, "r");
  assert.match(
    keptTry.body,
    /attempt 2 of 3 .*: the job's next run on v0\.13\.1 carries on from the rebase kept up to 6827d2572, so it may finish on its own;/,
  );
  assert.equal(keptTry.ask, conflict.ask);
  const lastTry = notice("conflict", undefined, 3, "r");
  assert.match(
    lastTry.body,
    /attempt 3 of 3 for upstream v0\.13\.1 with branch d975b4af3, so the job now waits for a new upstream release or a new commit on fork\/release; a commit added to the branch carries on from the rebase kept up to 6827d2572\./,
  );
  assert.doesNotMatch(lastTry.body, /next run on/);
  // A stop whose rebase was gone by the time the job read it is no empty commit.
  ctx.conflict = { files: [], diff: "", keptUpTo: null, aborted: true };
  const gone = notice("conflict", undefined, 1, "r").body;
  assert.match(gone, /the rebase was no longer in progress when the job looked/);
  assert.doesNotMatch(gone, /no file left unmerged/);
  ctx.conflict = { files: [], diff: "", keptUpTo: null };
  assert.match(notice("conflict", undefined, 1, "r").body, /stopped with no file left unmerged/);
  assert.match(
    notice("conflict", undefined, 3, "r").body,
    /so the job now waits for a new upstream release or a new commit on fork\/release\.\n/,
  );

  const retire = notice("failed", { step: "retire", message: "held" }, 1, "r");
  assert.match(
    retire.ask,
    /^Find which merged features' commits leave fork\/release .* is Tim's word$/,
  );
  assert.equal(notice("failed", { message: "boom" }, 1, "r").step, "job");

  // a step outside the branch, not yet counted: the body says the job retries it, the ask that
  // a service's fault needs no fix
  const github = { step: "github", message: "gh api: exit 1", outside: true };
  const uncounted = failureNotice({
    outcome: "failed",
    error: github,
    ctx,
    attempts: 0,
    counted: false,
    outsideSince: "2026-10-26T09:00:00.000Z",
    previous: "0.12.0-fork.2",
    runDir: "/x/paseo-release/runs/r",
    ...paths,
  });
  assert.match(uncounted.body, /not counted against upstream v0\.13\.1 with branch d975b4af3/);
  assert.match(uncounted.body, /since 2026-10-26T09:00:00\.000Z/);
  assert.doesNotMatch(uncounted.body, /attempt \d of/);
  assert.match(
    uncounted.ask,
    /^Find why the fork release failed at github .*; GitHub or Apple's notary down needs no fix/,
  );
  assert.ok(!uncounted.ask.includes("\n"));
  // counted once it has lasted a day, with the same ask, so it stays one subject
  const lasted = notice("failed", github, 1, "r2");
  assert.match(lasted.body, /attempt 1 of 3/);
  assert.equal(lasted.ask, uncounted.ask);
});

test("a notice with an ask goes to the door as an agent's ask, one without as a note", () => {
  const ask = "Find why the fork release failed at lint";
  const asked = deliverArgs({ level: "warn", title: "failed", key: "lint abc first", ask });
  assert.deepEqual(asked.slice(-4), ["--needs", "agent", "--ask", ask]);
  const note = deliverArgs({ level: "info", title: "resolved", key: "conflict resolved abc" });
  assert.deepEqual(note, [
    "deliver",
    "--source",
    "paseo-fork",
    "--level",
    "info",
    "--title",
    "resolved",
    "--key",
    "conflict resolved abc",
  ]);
  // Who a notice needs goes to the door as given, with an ask or without one (ALM-4030).
  const his = deliverArgs({ level: "warn", title: "held", key: "k", needs: "tim", ask });
  assert.deepEqual(his.slice(-4), ["--needs", "tim", "--ask", ask]);
  const bare = deliverArgs({ level: "warn", title: "held", key: "k", needs: "tim" });
  assert.deepEqual(bare.slice(-2), ["--needs", "tim"]);
  assert.equal(bare.includes("--ask"), false);
});

test("a standing notice asks the door for the one note its key names, whatever the day", () => {
  const args = deliverArgs({
    level: "warn",
    title: "t",
    key: "release v0dot13dot2",
    standing: true,
    ask: "a",
  });
  assert.deepEqual(args.slice(-5), ["--standing", "--needs", "agent", "--ask", "a"]);
  // The door drops a bare number from a key: two releases' keys differ in a word, not a number.
  assert.equal(releaseKey("v0.13.2"), "release v0dot13dot2");
  assert.notEqual(releaseKey("v0.13.1"), releaseKey("v0.13.2"));
  assert.notEqual(releaseKey("v0.1.32"), releaseKey("v0.13.2"));
});

test("an upstream release's failures rewrite its one note, and its publish settles it as a report", () => {
  const failed = {
    step: "lint",
    title: "Paseo fork release failed at lint (upstream v0.13.2)",
    body: "b",
    ask: "fix it",
  };
  const first = releaseNotices({ ctx: { latestTag: "v0.13.2" }, failed, runDir: "r1" });
  assert.deepEqual(first, {
    notices: [
      {
        level: "warn",
        standing: true,
        key: "release v0dot13dot2",
        title: failed.title,
        body: "b",
        ask: "fix it",
      },
    ],
    open: ["v0.13.2"],
  });
  // Another run on the same release, another step: the same note again, nothing more.
  const again = releaseNotices({
    ctx: { latestTag: "v0.13.2" },
    open: first.open,
    failed: { ...failed, step: "typecheck" },
    runDir: "r2",
  });
  assert.deepEqual(
    again.notices.map((notice) => notice.key),
    ["release v0dot13dot2"],
  );
  assert.deepEqual(again.open, ["v0.13.2"]);

  const out = releaseNotices({
    ctx: { latestTag: "v0.13.2", version: "0.13.2-fork.1" },
    open: again.open,
    runDir: "/x/runs/r3",
  });
  assert.deepEqual(out.open, []);
  assert.equal(out.notices.length, 1);
  const [report] = out.notices;
  assert.equal(report.key, "release v0dot13dot2");
  assert.equal(report.standing, true);
  assert.equal(report.level, "info");
  assert.equal(report.ask, undefined);
  assert.equal(report.title, "Paseo fork 0.13.2-fork.1 is out on upstream v0.13.2");
  assert.ok(report.body.includes(`Run log: /x/runs/r3 on ${HERE}.`), report.body);
  assert.doesNotMatch(report.body, /conflict/);
});

test("a newer upstream release settles an older one's note, and a quiet publish leaves none", () => {
  const failed = { step: "github", title: "t", body: "b", ask: "a" };
  const moved = releaseNotices({
    ctx: { latestTag: "v0.13.2" },
    open: ["v0.13.1"],
    failed,
    runDir: "r",
  });
  assert.deepEqual(
    moved.notices.map((notice) => [notice.key, notice.level, Boolean(notice.ask)]),
    [
      ["release v0dot13dot1", "info", false],
      ["release v0dot13dot2", "warn", true],
    ],
  );
  assert.match(moved.notices[0].body, /its own note stands for this one/);
  assert.deepEqual(moved.open, ["v0.13.2"]);

  const publish = { latestTag: "v0.13.2", version: "0.13.2-fork.1" };
  const skipped = releaseNotices({ ctx: publish, open: ["v0.13.1"], runDir: "r" });
  assert.deepEqual(
    skipped.notices.map((notice) => notice.key),
    ["release v0dot13dot1"],
  );
  assert.match(skipped.notices[0].body, /0\.13\.2-fork\.1 is out/);

  // A release that never failed publishes with no note, unless the conflict agent resolved one.
  assert.deepEqual(releaseNotices({ ctx: publish, runDir: "r" }), { notices: [], open: [] });
  const resolved = releaseNotices({ ctx: { ...publish, resolvedBy: "agent" }, runDir: "r" });
  assert.equal(resolved.notices.length, 1);
  assert.match(resolved.notices[0].body, /the conflict agent resolved it/);
});

test("a standing notice still waiting gives way to a newer one under its key", () => {
  const state = { pendingNotices: [{ key: "closed pr1", title: "closed" }] };
  queueNotice(state, { key: "release v0dot13dot2", standing: true, title: "failed" });
  queueNotice(state, { key: "release v0dot13dot1", standing: true, title: "older" });
  queueNotice(state, { key: "release v0dot13dot2", standing: true, title: "out" });
  assert.deepEqual(
    state.pendingNotices.map((notice) => notice.title),
    ["closed", "older", "out"],
  );
});
