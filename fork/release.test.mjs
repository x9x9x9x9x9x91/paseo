import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  branchSpecs,
  closedPulls,
  compareStableTags,
  decide,
  featureSubjects,
  forkOnlySubjects,
  forkVersion,
  nextForkNumber,
  nodeMajorFromWorkflow,
  parseStableTag,
  pathsOutsideScope,
  sameRequirement,
  shouldSkipCandidate,
} from "./release.mjs";
import { designatedRequirement } from "./sign-mac.cjs";

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

test("a fork release changes the app, the build config and the daemon patch only", () => {
  assert.deepEqual(
    pathsOutsideScope([
      "packages/app/src/panels/agent-panel.tsx",
      "packages/desktop/electron-builder.yml",
      "fork/release.mjs",
      "packages/server/src/server/agent/structured-generation-providers.ts",
      "packages/server/src/server/session.workspaces.test.ts",
      "packages/protocol/src/messages.ts",
      "packages/server/src/server/index.ts",
      "packages/server/src/server/session.test.ts",
      "packages/desktop/src/main.ts",
      "package-lock.json",
    ]),
    [
      "packages/server/src/server/index.ts",
      "packages/server/src/server/session.test.ts",
      "packages/desktop/src/main.ts",
      "package-lock.json",
    ],
  );
});

test("the gate runs every browser spec the branch adds or changes on upstream's tag", (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "fork-specs-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => {
    const identity = ["-c", "user.name=fork", "-c", "user.email=fork@example.invalid"];
    const unsigned = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
    const result = spawnSync("git", [...identity, ...unsigned, ...args], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  };
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  };
  const browser = "packages/app/e2e/browser";
  git("init", "-q");
  write(`${browser}/untouched.spec.ts`, "upstream's spec\n");
  write(`${browser}/changed.spec.ts`, "upstream's spec, which a feature changes\n");
  write(`${browser}/removed.spec.ts`, "upstream's spec, which a feature removes\n");
  git("add", "-A");
  git("commit", "-q", "-m", "upstream");
  git("tag", "v0.11.4");
  write(`${browser}/changed.spec.ts`, "the feature's change\n");
  write(`${browser}/added.spec.ts`, "the feature's spec\n");
  write(`${browser}/added.real.spec.ts`, "a spec that needs a real provider\n");
  write("packages/app/e2e/support/helpers/added.ts", "a helper\n");
  write("packages/app/src/added.spec.ts", "a spec outside the browser folder\n");
  rmSync(path.join(repo, browser, "removed.spec.ts"));
  git("add", "-A");
  git("commit", "-q", "-m", "feat(app): a feature");
  assert.deepEqual(branchSpecs("v0.11.4", { cwd: repo }), [
    "e2e/browser/added.spec.ts",
    "e2e/browser/changed.spec.ts",
  ]);
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
