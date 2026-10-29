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
  countFailure,
  decide,
  deliverArgs,
  dropFromTodo,
  failureNotice,
  featureSubjects,
  forkOnlySubjects,
  forkVersion,
  holdForNotary,
  liveIsOpen,
  nextForkNumber,
  nodeMajorFromWorkflow,
  notaryOutside,
  notaryRefusal,
  notaryRefused,
  OUTSIDE_STEPS,
  parseStableTag,
  pathsOutsideScope,
  queueNotice,
  releaseFileNames,
  releaseFilesProblem,
  releaseKey,
  releaseNotices,
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
  assert.equal(note.ask, undefined);
  assert.equal(deliverArgs(note).includes("--needs"), false);
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
  assert.match(
    first.body,
    /Run log: \/x\/paseo-release\/runs\/2026-10-26T09-32-38\.733Z on sincoder/,
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
  assert.match(report.body, /Run log: \/x\/runs\/r3 on sincoder/);
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
