#!/usr/bin/env node
// The fork's release job. Upstream's latest stable release plus this branch's own commits,
// checked, built, signed, notarized and published as a GitHub release on the fork, so the
// Mac app updates itself from there. It runs hourly on sincoder as a launch agent in the
// logged-in session, the only place its login keychain (signing, notary profile) is unlocked.
// fork/README.md has the version scheme, the failure policy and the retirement path.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { designatedRequirement } from "./sign-mac.cjs";

export const FORK_REPO = "x9x9x9x9x9x91/paseo";
export const UPSTREAM_REPO = "getpaseo/paseo";
export const RELEASE_BRANCH = "fork/release";
// Upstream pull requests that carry this branch's feature commits. Once all of them are in an
// upstream stable release, the fork has nothing left to add and retires. A pull upstream closes
// without merging gets a notice (noticeClosedPulls).
export const UPSTREAM_PULLS = [7176, 7313];
// The fork's own commits (the update feed, this job) say so in their subject; every other
// commit on the branch is a feature upstream does not have yet.
const FORK_SUBJECT = /^fork: /;
// A feature with no upstream pull says `Upstream: none` in its message. Upstream merging the
// fork's pulls does not retire the fork while one is on the branch: the handover would drop it.
const UPSTREAM_TRAILER = "Upstream";
// The daemon files the fork patches: a chat on a custom provider (zero retention) has its
// workspace named and its commit text written on that provider only. Their tests run in the gate.
const DAEMON_PATCH_FILES = [
  "packages/protocol/src/messages.ts",
  "packages/server/src/server/agent/create-agent/create.ts",
  "packages/server/src/server/agent/structured-generation-providers.ts",
  "packages/server/src/server/agent/tools/paseo-tools.ts",
  "packages/server/src/server/schedule/service.ts",
  "packages/server/src/server/session.ts",
  "packages/server/src/server/session/checkout/git-metadata-generator.ts",
  "packages/server/src/server/worktree-branch-name-generator.ts",
];
const DAEMON_PATCH_TESTS = [
  "src/server/agent/create-agent/create.test.ts",
  "src/server/agent/mcp-server.test.ts",
  "src/server/agent/structured-generation-providers.test.ts",
  "src/server/session/checkout/git-metadata-generator.test.ts",
  "src/server/schedule/service.test.ts",
  "src/server/session.workspaces.test.ts",
  "src/server/worktree-branch-name-generator.test.ts",
];
// A fork release changes the app, the build config and the daemon patch's files only. The
// rest of the daemon, the CLI and every other package stay upstream's source of the same tag,
// lockfile included.
const ALLOWED_PATHS = [/^packages\/app\//, /^packages\/desktop\/electron-builder\.yml$/, /^fork\//];
const DAEMON_PATCH_PATHS = new Set([
  ...DAEMON_PATCH_FILES,
  ...DAEMON_PATCH_TESTS.map((file) => `packages/server/${file}`),
]);
const LABEL = "com.alma.paseo-fork-release";
// electron-builder signs through this hook, which lets the app accept upstream's signature too.
const SIGN_HOOK = fileURLToPath(new URL("./sign-mac.cjs", import.meta.url));
const NOTARY_PROFILE = process.env.PASEO_FORK_NOTARY_PROFILE ?? "substrate-notary";
// Notices go through Alma's notification door on sin0, whose dead-man probe also reads
// state.json when this job goes quiet.
const SIN0 = process.env.PASEO_FORK_NOTIFY_HOST ?? "sin0";
const NOTIFY_COMMAND =
  "/usr/bin/python3 /Users/sin0/Vault/Alma/Code/scheduled-tasks/vault_notifications.py";
// Every state write is copied to sin0 (home-relative), where sched_watch warns once the job
// has not checked upstream for 12 hours.
const SIN0_STATE = "Vault/Alma/Local/Task-State/paseo-fork/state.json";
// The conflict agent reaches sin0's model proxy through a tunnel: sincoder holds no login.
const PROXY_PORT = 18318;
const AGENT_MODEL = "claude-opus-5-5";
// A candidate that failed this many runs waits for a new upstream release or a new commit on
// the branch instead of rebuilding every hour.
const MAX_ATTEMPTS = 3;
// The features' browser specs are the ones the branch adds or changes against upstream's tag,
// read from the branch each run, so no rebase or hand edit can leave a feature's spec out of
// the gate. A `.real.spec.ts` needs a real provider and is not in the browser project.
const APP_DIR = "packages/app/";
const BROWSER_SPEC = /^packages\/app\/e2e\/browser\/.+\.spec\.ts$/;
const REAL_SPEC = /\.real\.spec\.ts$/;

const ROOT = process.env.PASEO_FORK_ROOT ?? path.join(os.homedir(), "Coding/_forks/paseo-release");
const BUILD = path.join(ROOT, "build");
const STATE_FILE = path.join(ROOT, "state.json");
const LOCK_FILE = path.join(ROOT, "lock");
const RUNS = path.join(ROOT, "runs");
const JOB_LOG = path.join(ROOT, "job.log");
const KEEP_RUNS = 20;

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export function parseStableTag(tag) {
  const match = STABLE_TAG.exec(tag ?? "");
  return match ? match.slice(1, 4).map(Number) : null;
}

export function compareStableTags(left, right) {
  const a = parseStableTag(left);
  const b = parseStableTag(right);
  if (!a || !b) throw new Error(`not a stable tag: ${a ? right : left}`);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/**
 * The fork's version of an upstream release: `0.11.4-fork.1`, then `-fork.2` for the next
 * fork build of the same release. Semver reads it newer than every older upstream release and
 * every earlier fork build, so the app updates, and older than the stock release it is built on.
 */
export function forkVersion(upstreamTag, number) {
  return `${upstreamTag.slice(1)}-fork.${number}`;
}

export function nextForkNumber(upstreamTag, releaseTags) {
  const prefix = `${upstreamTag.slice(1)}-fork.`;
  let highest = 0;
  for (const tag of releaseTags) {
    if (!tag.startsWith(prefix)) continue;
    const number = Number(tag.slice(prefix.length));
    if (Number.isInteger(number) && number > highest) highest = number;
  }
  return highest + 1;
}

export function pathsOutsideScope(paths) {
  return paths.filter(
    (file) => !DAEMON_PATCH_PATHS.has(file) && !ALLOWED_PATHS.some((pattern) => pattern.test(file)),
  );
}

export function featureSubjects(subjects) {
  return subjects.filter((subject) => !FORK_SUBJECT.test(subject));
}

/** Subjects of the commits whose `Upstream` trailer is `none`, from `subject\tvalue` lines. */
export function forkOnlySubjects(lines) {
  return lines
    .map((line) => line.split("\t"))
    .filter(([, upstream]) => upstream?.trim().toLowerCase() === "none")
    .map(([subject]) => subject);
}

/**
 * What a run has to do: `rebase` onto a newer upstream release, `release` a branch head the
 * fork has not published yet, or nothing (`current`). A branch ahead of upstream's latest
 * release (upstream took a release back) waits for upstream to catch up.
 */
export function decide({ latestTag, baseTag, head, publishedCommit }) {
  const order = compareStableTags(latestTag, baseTag);
  if (order < 0) return "current";
  if (order > 0) return "rebase";
  return publishedCommit === head ? "current" : "release";
}

/** A candidate is retried until it has failed MAX_ATTEMPTS runs. */
export function shouldSkipCandidate(failure, candidate) {
  return failure?.candidate === candidate && failure.attempts >= MAX_ATTEMPTS;
}

export function nodeMajorFromWorkflow(workflow) {
  const match = /node-version:\s*["']?(\d+)/.exec(workflow);
  return match ? Number(match[1]) : null;
}

/** codesign prints a requirement its own way (quotes, `exists` comments); compare what it says. */
export function sameRequirement(printed, expected) {
  const plain = (text) =>
    text
      .replace(/\/\*.*?\*\//g, "")
      .replaceAll('"', "")
      .replace(/\s+/g, " ")
      .trim();
  return plain(printed) === plain(expected);
}

class StepFailure extends Error {
  constructor(step, message, logFile = null) {
    super(message);
    this.step = step;
    this.logFile = logFile;
  }
}

function parseArgs(argv) {
  const options = { dryRun: false, branch: RELEASE_BRANCH, force: false, retire: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--retire") options.retire = true;
    else if (arg === "--branch") options.branch = argv[++index];
    else {
      throw new Error(
        `unknown argument ${arg}; use --dry-run, --force, --retire or --branch <name>`,
      );
    }
  }
  // A release from another branch, a second release of a released commit or a handover
  // nobody asked for would become every fork app's update.
  if ((options.branch !== RELEASE_BRANCH || options.force || options.retire) && !options.dryRun) {
    throw new Error("--branch, --force and --retire build only with --dry-run");
  }
  return options;
}

function now() {
  return new Date().toISOString();
}

function log(message) {
  const line = `${now()} ${message}\n`;
  process.stdout.write(line);
  appendFileSync(JOB_LOG, line);
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  const next = `${STATE_FILE}.next`;
  writeFileSync(next, text);
  renameSync(next, STATE_FILE);
  const remote = `mkdir -p ${path.posix.dirname(SIN0_STATE)} && cat > ${SIN0_STATE}.next && mv ${SIN0_STATE}.next ${SIN0_STATE}`;
  const copied = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", SIN0, remote],
    {
      input: text,
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  if (copied.status !== 0) log(`state not copied to ${SIN0} (exit ${copied.status})`);
}

function acquireLock() {
  try {
    const fd = openSync(LOCK_FILE, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    const holder = Number(readFileSync(LOCK_FILE, "utf8"));
    // The lock holds while its pid is still this job. An empty lock (the run died between
    // creating and writing it) or a pid another process took after a restart is stale.
    const command =
      holder > 0
        ? spawnSync("ps", ["-o", "command=", "-p", String(holder)], { encoding: "utf8" })
        : null;
    if (command?.status === 0 && command.stdout.includes("release.mjs")) return false;
    unlinkSync(LOCK_FILE);
    return acquireLock();
  }
}

/**
 * Run a command in the build clone. With a step, its output goes to that step's log in the
 * run folder (streamed, for the long steps); a non-zero exit fails the step unless `quiet`.
 */
function run(
  command,
  args,
  { step, runDir, cwd = BUILD, env = {}, input, timeoutMs, quiet, stream } = {},
) {
  const logFile = runDir && step ? path.join(runDir, `${step}.log`) : null;
  const options = { cwd, env: { ...process.env, ...env }, input, timeout: timeoutMs };
  let result;
  if (stream && logFile) {
    appendFileSync(logFile, `$ ${command} ${args.join(" ")}\n`);
    const fd = openSync(logFile, "a");
    try {
      result = spawnSync(command, args, { ...options, stdio: ["ignore", fd, fd] });
    } finally {
      closeSync(fd);
    }
  } else {
    result = spawnSync(command, args, {
      ...options,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (logFile) {
      appendFileSync(
        logFile,
        `$ ${command} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
      );
    }
  }
  if (logFile) appendFileSync(logFile, `exit=${result.status}\n`);
  if (result.status !== 0 && !quiet) {
    const reason = result.error?.message ?? `exit ${result.status}`;
    throw new StepFailure(step ?? command, `${command} ${args.join(" ")}: ${reason}`, logFile);
  }
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  return { status: result.status, stdout, output: `${stdout}\n${stderr}`.trim() };
}

function git(args, options = {}) {
  return run("git", args, { step: "git", ...options }).stdout;
}

function gh(args, options = {}) {
  return run("gh", args, { step: "github", ...options }).stdout;
}

function rebaseInProgress() {
  return ["rebase-merge", "rebase-apply"].some((dir) => existsSync(path.join(BUILD, ".git", dir)));
}

function forkReleases(runDir) {
  const lines = gh(
    [
      "api",
      `repos/${FORK_REPO}/releases?per_page=100`,
      "--paginate",
      "--jq",
      ".[] | [.tag_name, .draft, .id, .target_commitish] | @tsv",
    ],
    { runDir },
  );
  return lines
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [tag, draft, id, target] = line.split("\t");
      return { tag, draft: draft === "true", id, target };
    });
}

/** Where upstream and the branch stand. Any failure here is GitHub or the network. */
function poll(options, runDir) {
  git(["fetch", "-q", "--prune", "--tags", "origin"], { runDir });
  git(["fetch", "-q", "--tags", "--force", "upstream"], { runDir });
  // GitHub's latest release is the newest published one that is neither draft nor prerelease.
  const latestTag = gh(["api", `repos/${UPSTREAM_REPO}/releases/latest`, "--jq", ".tag_name"], {
    runDir,
  });
  if (!parseStableTag(latestTag)) throw new Error(`upstream's latest release has tag ${latestTag}`);
  const branchRef = `origin/${options.branch}`;
  const head = git(["rev-parse", branchRef], { runDir });
  const baseTag = git(
    ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "--exclude", "*-*", branchRef],
    {
      runDir,
    },
  );
  const published = run(
    "gh",
    ["api", `repos/${FORK_REPO}/releases/latest`, "--jq", "[.target_commitish, .tag_name] | @tsv"],
    {
      runDir,
      quiet: true,
    },
  );
  const [publishedCommit = null, publishedVersion = null] =
    published.status === 0 ? published.stdout.split("\t") : [];
  return { latestTag, head, baseTag, publishedCommit, publishedVersion };
}

function commitSubjects(range, runDir) {
  return git(["log", "--format=%s", "--reverse", range], { runDir }).split("\n").filter(Boolean);
}

function forkOnlyCommits(range, runDir) {
  const format = `%s%x09%(trailers:key=${UPSTREAM_TRAILER},valueonly,separator=%x2C)`;
  const lines = git(["log", `--format=${format}`, "--reverse", range], { runDir });
  return forkOnlySubjects(lines.split("\n").filter(Boolean));
}

/** An upstream pull as GitHub has it (`state` is open or closed), or null when a quiet read fails. */
function upstreamPull(pull, runDir, { quiet = false } = {}) {
  const read = run(
    "gh",
    [
      "api",
      `repos/${UPSTREAM_REPO}/pulls/${pull}`,
      "--jq",
      "[.state, .merged, .merge_commit_sha] | @tsv",
    ],
    { step: "github", runDir, quiet },
  );
  if (read.status !== 0) return null;
  const [state, merged, sha] = read.stdout.split("\t");
  return { state, merged: merged === "true", sha };
}

function upstreamPullsLanded(stableTag, runDir) {
  return UPSTREAM_PULLS.every((pull) => {
    const { merged, sha } = upstreamPull(pull, runDir);
    if (!merged) return false;
    return (
      run("git", ["merge-base", "--is-ancestor", sha, stableTag], { quiet: true }).status === 0
    );
  });
}

/**
 * The listed pulls upstream closed without merging: `untold` still need their notice, `told`
 * already had it. `reads` pairs each pull with GitHub's `{ state, merged }`, or null when it
 * could not be read, which keeps a told pull told. A told pull that reopened drops out, so
 * closing it again is news again.
 */
export function closedPulls(reads, told = []) {
  const result = { untold: [], told: [] };
  for (const [pull, read] of reads) {
    const closed = read ? read.state === "closed" && !read.merged : told.includes(pull);
    if (closed) result[told.includes(pull) ? "told" : "untold"].push(pull);
  }
  return result;
}

/** The checks and the build run on the Node major upstream's own release workflow uses. */
function nodeEnv(tag, runDir) {
  const workflow = git(["show", `${tag}:.github/workflows/desktop-release.yml`], { runDir });
  const major = nodeMajorFromWorkflow(workflow);
  if (!major)
    throw new StepFailure("node", "no node-version in upstream's desktop release workflow");
  const bin = `/opt/homebrew/opt/node@${major}/bin`;
  if (!existsSync(path.join(bin, "node"))) {
    run("brew", ["install", `node@${major}`], { step: "node", runDir, timeoutMs: 20 * 60_000 });
  }
  return { PATH: `${bin}:${process.env.PATH}` };
}

// What every build needs before it starts, the handover's included.
const PREPARE_STEPS = [
  ["npm-ci", "node", ["scripts/npm-retry.mjs", "ci"]],
  // npm ci leaves electron/dist empty here; the build and its smoke test need the binary.
  ["electron", "node", ["node_modules/electron/install.js"]],
];

function runSteps(steps, { runDir, env }) {
  for (const [step, command, args] of steps) {
    const started = Date.now();
    run(command, args, { step, runDir, env, stream: true, timeoutMs: 60 * 60_000 });
    log(`  ${step} ok (${Math.round((Date.now() - started) / 1000)} s)`);
  }
}

function gate({ runDir, env, specs }) {
  const steps = [
    ...PREPARE_STEPS,
    // The browser the app's tests and the specs need, which moves with upstream's Playwright.
    ["playwright", "npx", ["playwright", "install", "chromium"]],
    ["release-tests", "node", ["--test", "fork/release.test.mjs"]],
    ["format", "npm", ["run", "format:check"]],
    ["lint", "npm", ["run", "lint"]],
    ["build-server", "npm", ["run", "build:server"]],
    ["typecheck", "npm", ["run", "typecheck"]],
    ["app-deps", "npm", ["run", "build:app-deps"]],
    ["app-unit", "npm", ["run", "test", "--workspace=@getpaseo/app"]],
    [
      "daemon-patch-unit",
      "npm",
      ["run", "test:unit", "--workspace=@getpaseo/server", "--", ...DAEMON_PATCH_TESTS],
    ],
    ["two-way-audio", "npm", ["run", "build", "--workspace=@getpaseo/expo-two-way-audio"]],
  ];
  // Without a spec named, the step would run every one of upstream's. None comes back only for
  // a branch that leaves the app alone (branchSpecs).
  if (specs.length > 0) {
    steps.push(["e2e", "npm", ["run", "test:e2e", "--workspace=@getpaseo/app", "--", ...specs]]);
  } else {
    log("  e2e skipped: the branch does not change the app");
  }
  runSteps(steps, { runDir, env });
}

/**
 * The app's browser specs the branch adds or changes against `tag`, as the e2e step names them.
 * A branch that changes the app has at least one, or the gate would publish its features untested.
 */
export function branchSpecs(tag, { runDir, cwd } = {}) {
  const changed = git(
    ["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=d", tag, "HEAD"],
    { runDir, cwd },
  )
    .split("\n")
    .filter(Boolean);
  const specs = changed
    .filter((file) => BROWSER_SPEC.test(file) && !REAL_SPEC.test(file))
    .map((file) => file.slice(APP_DIR.length));
  if (specs.length === 0 && changed.some((file) => file.startsWith(APP_DIR))) {
    throw new StepFailure(
      "specs",
      `the branch changes the app on ${tag} but adds or changes no browser spec under ${APP_DIR}e2e/browser, so the gate would not test its features`,
    );
  }
  return specs;
}

function checkScope(tag, runDir) {
  const changed = git(["diff", "--name-only", tag, "HEAD"], { runDir }).split("\n").filter(Boolean);
  const outside = pathsOutsideScope(changed);
  if (outside.length > 0) {
    throw new StepFailure(
      "scope",
      `the branch changes files outside the app and the daemon patch: ${outside.join(", ")}`,
    );
  }
}

/** The Mac app, versioned, updating from `owner`'s releases, signed through SIGN_HOOK. */
function buildDesktop({ version, owner, runDir, env }) {
  const packagePath = path.join(BUILD, "packages/desktop/package.json");
  const original = readFileSync(packagePath, "utf8");
  const releaseDir = path.join(BUILD, "packages/desktop/release");
  rmSync(releaseDir, { recursive: true, force: true });
  writeFileSync(packagePath, `${JSON.stringify({ ...JSON.parse(original), version }, null, 2)}\n`);
  const started = Date.now();
  try {
    run(
      "npm",
      [
        "run",
        "build:desktop",
        "--",
        "--publish",
        "never",
        "--mac",
        "--arm64",
        "-c.publish.releaseType=release",
        "-c.publish.channel=latest",
        `-c.publish.owner=${owner}`,
        `-c.mac.sign=${SIGN_HOOK}`,
      ],
      {
        step: "build",
        runDir,
        stream: true,
        timeoutMs: 120 * 60_000,
        env: {
          ...env,
          APPLE_KEYCHAIN_PROFILE: NOTARY_PROFILE,
          PASEO_DESKTOP_SMOKE: "1",
          PASEO_DESKTOP_SMOKE_ARTIFACT_DIR: path.join(runDir, "smoke"),
          NODE_OPTIONS: "--max-old-space-size=8192",
        },
      },
    );
  } finally {
    writeFileSync(packagePath, original);
  }
  log(`  build ok (${Math.round((Date.now() - started) / 1000)} s)`);
  return releaseDir;
}

/**
 * The release is what electron-updater expects, signed, notarized, pointing at `owner` and
 * accepting upstream's signature for its next update.
 */
function verifyRelease({ releaseDir, version, owner, runDir }) {
  const step = "verify";
  const app = path.join(releaseDir, "mac-arm64", "Paseo.app");
  const plist = path.join(app, "Contents/Info.plist");
  // Also fails an app that does not satisfy its own designated requirement.
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { step, runDir });
  const identifier = run("plutil", ["-extract", "CFBundleIdentifier", "raw", plist], {
    step,
    runDir,
  }).stdout;
  const designated = run("codesign", ["-d", "-r-", app], { step, runDir })
    .output.split("\n")
    .find((line) => line.startsWith("designated => "));
  if (!designated || !sameRequirement(designated, designatedRequirement(identifier))) {
    throw new StepFailure(
      step,
      `the app's designated requirement is not the fork's two-team one: ${designated}`,
    );
  }
  const assessment = run("spctl", ["--assess", "--type", "execute", "--verbose=4", app], {
    step,
    runDir,
  });
  if (!assessment.output.includes("Notarized Developer ID")) {
    throw new StepFailure(step, `the app is not notarized: ${assessment.output}`);
  }
  run("xcrun", ["stapler", "validate", app], { step, runDir });
  const bundleVersion = run("plutil", ["-extract", "CFBundleShortVersionString", "raw", plist], {
    step,
    runDir,
  }).stdout;
  if (bundleVersion !== version) {
    throw new StepFailure(step, `the app says version ${bundleVersion}, expected ${version}`);
  }
  const feed = readFileSync(path.join(app, "Contents/Resources/app-update.yml"), "utf8");
  if (!new RegExp(`^owner: ${owner}$`, "m").test(feed) || !/^channel: latest$/m.test(feed)) {
    throw new StepFailure(step, `the app's update feed is not ${owner}, channel latest:\n${feed}`);
  }
  const files = [
    `Paseo-${version}-arm64.dmg`,
    `Paseo-${version}-arm64.dmg.blockmap`,
    `Paseo-${version}-arm64.zip`,
    `Paseo-${version}-arm64.zip.blockmap`,
    "latest-mac.yml",
  ];
  const present = new Set(readdirSync(releaseDir));
  const missing = files.filter((name) => !present.has(name));
  if (missing.length > 0)
    throw new StepFailure(step, `missing release files: ${missing.join(", ")}`);
  const manifestPath = path.join(releaseDir, "latest-mac.yml");
  if (!readFileSync(manifestPath, "utf8").split("\n").includes(`version: ${version}`)) {
    throw new StepFailure(step, `latest-mac.yml does not name version ${version}`);
  }
  // Upstream's merge step adds the macOS minimum the updater checks; with one architecture it
  // merges the manifest with itself.
  run("node", ["scripts/merge-mac-manifest.mjs", manifestPath, manifestPath, manifestPath], {
    step,
    runDir,
  });
  // No staged rollout on the fork: the app takes the update at its next check.
  const releaseDate = now();
  const stampArgs = ["--release-date", releaseDate, "--rollout-hours", "0", manifestPath];
  run("node", ["scripts/stamp-rollout.mjs", ...stampArgs], { step, runDir });
  run("node", ["scripts/validate-desktop-manifests.mjs", ...stampArgs], { step, runDir });
  return files.map((name) => path.join(releaseDir, name));
}

function publish({ version, target, files, notes, runDir }) {
  const step = "publish";
  const notesFile = path.join(runDir, "notes.md");
  writeFileSync(notesFile, notes);
  const repo = ["--repo", FORK_REPO];
  run(
    "gh",
    [
      "release",
      "create",
      version,
      ...repo,
      "--target",
      target,
      "--title",
      `Paseo ${version}`,
      "--notes-file",
      notesFile,
      "--draft",
    ],
    { step, runDir },
  );
  run("gh", ["release", "upload", version, ...files, ...repo, "--clobber"], {
    step,
    runDir,
    timeoutMs: 30 * 60_000,
  });
  run("gh", ["release", "edit", version, ...repo, "--draft=false", "--latest"], { step, runDir });
  // GitHub's latest release settles a few seconds after the edit.
  let latest = "";
  for (let attempt = 0; attempt < 6 && latest !== version; attempt += 1) {
    if (attempt > 0) spawnSync("sleep", ["10"]);
    latest = run("gh", ["api", `repos/${FORK_REPO}/releases/latest`, "--jq", ".tag_name"], {
      step,
      runDir,
      quiet: true,
    }).stdout;
  }
  if (latest !== version)
    throw new StepFailure(step, `the fork's latest release is ${latest}, not ${version}`);
}

function releaseNotes({ upstreamTag, features }) {
  const upstream = `[${upstreamTag}](https://github.com/${UPSTREAM_REPO}/releases/tag/${upstreamTag})`;
  const list = features.map((subject) => `- ${subject}`).join("\n");
  return `Upstream Paseo ${upstream} plus:\n\n${list}\n\nBuilt, signed and notarized on sincoder by fork/release.mjs. The Mac app updates itself from this repository's releases.\n`;
}

function handoverNotes({ upstreamTag }) {
  const upstream = `[${upstreamTag}](https://github.com/${UPSTREAM_REPO}/releases/tag/${upstreamTag})`;
  return `Upstream Paseo ${upstream}, unchanged, and the fork's last release: upstream now carries the fork's features. Signed by the fork so a fork app takes it, it updates from upstream's releases, so the app moves on to stock Paseo by itself.\n\nBuilt, signed and notarized on sincoder by fork/release.mjs.\n`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * Deliver a notice through Alma's door on sin0; false when sin0 could not take it. The door
 * keeps one note per key and day and drops bare numbers from it, so the key carries the
 * branch head to keep two releases' notices apart.
 */
function notify({ level, title, body, key }) {
  const remote = `${NOTIFY_COMMAND} deliver --source paseo-fork --level ${level} --title ${shellQuote(title)} --key ${shellQuote(key)}`;
  const result = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", SIN0, remote],
    {
      input: body,
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  if (result.status !== 0)
    log(`notice not delivered (exit ${result.status}): ${result.stderr?.trim()}`);
  return result.status === 0;
}

function tail(file, lines = 40) {
  if (!file || !existsSync(file)) return "";
  return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
}

function conflictPrompt({ commit, oldBase, newBase, files }) {
  return `You are resolving a git rebase conflict in a fork of Paseo (${FORK_REPO}).
The fork's release branch is upstream's stable tag plus a few commits of its own. They are being replayed from ${oldBase} onto upstream's new stable tag ${newBase}, and commit ${commit} stopped on conflicts in:
${files.map((file) => `- ${file}`).join("\n")}

Read the commit (git show REBASE_HEAD), what upstream changed in those files (git log -p ${oldBase}..${newBase} -- <file>), and the conflicted files. Resolve every conflict so the commit does what it did before, written against upstream's new code. Keep upstream's changes; adapt the commit, not upstream. Remove every conflict marker and git add each resolved file.

Do not commit, do not run git rebase, do not install packages, build or run tests, and do not edit other files unless the commit needs it. The job runs typecheck, lint and the tests after you.

End your reply with one line: RESOLVED, or CANNOT: <one sentence why>.`;
}

function withProxyTunnel(runDir, body) {
  // One socket path, so a tunnel a dead run left behind is closed before this one opens.
  const socket = path.join(ROOT, "tunnel.sock");
  const step = "conflict-agent";
  run("ssh", ["-S", socket, "-O", "exit", SIN0], { step, runDir, quiet: true });
  const forward = `${PROXY_PORT}:127.0.0.1:8318`;
  const options = ["-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-L", forward];
  run("ssh", ["-M", "-S", socket, "-fN", ...options, SIN0], { step, runDir, timeoutMs: 60_000 });
  try {
    return body();
  } finally {
    run("ssh", ["-S", socket, "-O", "exit", SIN0], { step, runDir, quiet: true });
  }
}

function unmergedFiles(runDir) {
  return git(["diff", "--name-only", "--diff-filter=U"], { runDir }).split("\n").filter(Boolean);
}

/** One headless agent attempt per conflicting stop of the rebase; false leaves it to Tim. */
function resolveConflicts({ oldBase, newBase, runDir }) {
  const configDir = path.join(ROOT, "agent-config");
  mkdirSync(configDir, { recursive: true });
  return withProxyTunnel(runDir, () => {
    for (let stop = 0; stop < 5 && rebaseInProgress(); stop += 1) {
      const files = unmergedFiles(runDir);
      if (files.length === 0) return false;
      const commit = git(["rev-parse", "--short", "REBASE_HEAD"], { runDir });
      log(`  conflict agent on ${commit}: ${files.join(", ")}`);
      const reply = run(
        "claude",
        [
          "-p",
          conflictPrompt({ commit, oldBase, newBase, files }),
          "--model",
          AGENT_MODEL,
          "--permission-mode",
          "acceptEdits",
          "--allowedTools",
          "Read,Edit,Write,Glob,Grep,Bash(git show:*),Bash(git log:*),Bash(git diff:*),Bash(git status:*),Bash(git add:*)",
        ],
        {
          step: "conflict-agent",
          runDir,
          quiet: true,
          timeoutMs: 40 * 60_000,
          env: {
            CLAUDE_CONFIG_DIR: configDir,
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${PROXY_PORT}`,
            ANTHROPIC_AUTH_TOKEN: "vibeproxy-dummy",
            ANTHROPIC_API_KEY: "",
          },
        },
      );
      const markers = run("git", ["grep", "-l", "-E", "^(<<<<<<<|>>>>>>>) ", "--", ...files], {
        runDir,
        quiet: true,
      }).stdout;
      if (reply.status !== 0 || !/RESOLVED\s*$/.test(reply.stdout) || markers) return false;
      git(["add", "--", ...files], { runDir });
      run("git", ["rebase", "--continue"], {
        step: "rebase",
        runDir,
        quiet: true,
        env: { GIT_EDITOR: "true" },
      });
    }
    return !rebaseInProgress();
  });
}

function rebaseOnto({ newBase, oldBase, head, runDir }) {
  git(["checkout", "-q", "-f", "--detach", head], { runDir });
  const rebase = ["rebase", "--onto", newBase, oldBase];
  if (run("git", rebase, { step: "rebase", runDir, quiet: true }).status === 0) {
    return { resolvedBy: null };
  }
  if (resolveConflicts({ oldBase, newBase, runDir })) return { resolvedBy: "agent" };
  // Read where the rebase stopped last, which is not the first stop when the agent got further.
  const files = rebaseInProgress() ? unmergedFiles(runDir) : [];
  const diff = run("git", ["diff"], { runDir, quiet: true }).stdout.slice(0, 6000);
  if (rebaseInProgress()) run("git", ["rebase", "--abort"], { runDir, quiet: true });
  return { conflict: { files, diff } };
}

function pruneRuns() {
  const runs = readdirSync(RUNS).sort();
  for (const old of runs.slice(0, Math.max(0, runs.length - KEEP_RUNS))) {
    rmSync(path.join(RUNS, old), { recursive: true, force: true });
  }
}

function retireLaunchAgent() {
  const plist = path.join(os.homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
  if (existsSync(plist)) renameSync(plist, `${plist}.retired-${now().slice(0, 10)}`);
}

/**
 * Build, verify and publish the checked-out tree as the fork's next release. A `handover` is
 * the last one: upstream's own tag, updating from upstream's releases.
 */
function release({ ctx, options, env, runDir, features, handover = false }) {
  // A draft is what an earlier run of this job left when it died mid-publish.
  const ours = (entry) => /-fork\.\d+$/.test(entry.tag);
  if (!options.dryRun) {
    for (const draft of forkReleases(runDir).filter((entry) => entry.draft && ours(entry))) {
      gh(["api", "-X", "DELETE", `repos/${FORK_REPO}/releases/${draft.id}`], { runDir });
    }
  }
  const tags = forkReleases(runDir).map((entry) => entry.tag);
  ctx.version = forkVersion(ctx.latestTag, nextForkNumber(ctx.latestTag, tags));
  const owner = (handover ? UPSTREAM_REPO : FORK_REPO).split("/")[0];
  log(`  building ${ctx.version}${handover ? `, updating from ${owner}` : ""}`);
  const releaseDir = buildDesktop({ version: ctx.version, owner, runDir, env });
  const files = verifyRelease({ releaseDir, version: ctx.version, owner, runDir });
  log(`  signed, notarized and verified ${ctx.version}`);
  if (options.dryRun) {
    log(`  dry run, not published: ${releaseDir}`);
    return;
  }
  // The release's commit has to be on the fork before GitHub can tag it.
  const target = git(["rev-parse", "HEAD"], { runDir });
  if (handover) {
    // Upstream's tagged commit need not be on any fork branch; the release's own tag carries
    // it there, and the branch stays where its last feature release left it. Forced, because
    // a run that died before creating the release can have left the tag on an older commit.
    git(["push", "--force", "origin", `${target}:refs/tags/${ctx.version}`], { runDir });
  } else if (target !== ctx.head) {
    const lease = `--force-with-lease=${options.branch}:${ctx.head}`;
    git(["push", lease, "origin", `HEAD:refs/heads/${options.branch}`], { runDir });
  }
  publish({
    version: ctx.version,
    target,
    files,
    notes: handover
      ? handoverNotes({ upstreamTag: ctx.latestTag })
      : releaseNotes({ upstreamTag: ctx.latestTag, features }),
    runDir,
  });
  ctx.publishedCommit = target;
  log(`  published https://github.com/${FORK_REPO}/releases/tag/${ctx.version}`);
}

/**
 * Upstream carries the fork's features, so the fork hands the app back and stops. Its last
 * release is upstream's tag as it is, updating from upstream's releases: a fork app takes it
 * because the fork signed it, and it takes stock Paseo next because its designated requirement
 * names upstream's team too (sign-mac.cjs). Upstream's release workflow already checked the tag.
 */
function retire({ ctx, options, runDir, reason }) {
  // A feature release always targets a commit on top of upstream's, so a latest release on
  // upstream's own commit is a handover an earlier run published without recording it. Read
  // from its tag (poll fetched the fork's tags): the handover pushes its tag before creating the
  // release, and GitHub does not promise target_commitish for a release on an existing tag.
  const upstreamCommit = git(["rev-parse", `${ctx.latestTag}^{commit}`], { runDir });
  const latestTagged = ctx.publishedVersion
    ? run("git", ["rev-parse", "-q", "--verify", `refs/tags/${ctx.publishedVersion}^{commit}`], {
        runDir,
        quiet: true,
      }).stdout
    : "";
  if (!options.retire && latestTagged === upstreamCommit) {
    ctx.version = ctx.publishedVersion;
    log(`  ${reason}: the handover ${ctx.version} is already out`);
    return "retired";
  }
  log(`  ${reason}: handing the app back to upstream`);
  git(["checkout", "-q", "-f", "--detach", ctx.latestTag], { runDir });
  const env = nodeEnv(ctx.latestTag, runDir);
  runSteps(PREPARE_STEPS, { runDir, env });
  release({ ctx, options, env, runDir, handover: true });
  return "retired";
}

function work({ ctx, options, plan, runDir }) {
  // A run that died mid-rebase leaves it in progress; the next one starts clean.
  if (rebaseInProgress()) run("git", ["rebase", "--abort"], { runDir, quiet: true });
  if (options.retire) return retire({ ctx, options, runDir, reason: "--retire" });
  // With no pull left to wait for, only fork-only features remain and the rebase carries them.
  if (
    plan === "rebase" &&
    UPSTREAM_PULLS.length > 0 &&
    upstreamPullsLanded(ctx.latestTag, runDir)
  ) {
    const forkOnly = forkOnlyCommits(`${ctx.baseTag}..${ctx.head}`, runDir);
    if (forkOnly.length > 0) {
      throw new StepFailure(
        "retire",
        `upstream ${ctx.latestTag} carries the fork's pulls, but ${forkOnly.join("; ")} has no upstream pull, so the fork keeps the app. Take the merged features' commits off ${RELEASE_BRANCH} and their pulls out of UPSTREAM_PULLS; the next run rebases the rest onto ${ctx.latestTag}.`,
      );
    }
    const reason = `upstream ${ctx.latestTag} carries the fork's pulls`;
    return retire({ ctx, options, runDir, reason });
  }
  if (plan === "rebase") {
    const rebased = rebaseOnto({
      newBase: ctx.latestTag,
      oldBase: ctx.baseTag,
      head: ctx.head,
      runDir,
    });
    if (rebased.conflict) {
      ctx.conflict = rebased.conflict;
      return "conflict";
    }
    ctx.resolvedBy = rebased.resolvedBy;
  } else {
    git(["checkout", "-q", "-f", "--detach", ctx.head], { runDir });
  }
  const features = featureSubjects(commitSubjects(`${ctx.latestTag}..HEAD`, runDir));
  if (features.length === 0 && plan !== "rebase") {
    throw new StepFailure("branch", `${options.branch} has no feature commit on ${ctx.latestTag}`);
  }
  if (features.length === 0) {
    // The rebase dropped every feature commit as already upstream: the same as a merged pull.
    return retire({ ctx, options, runDir, reason: `no feature commit left on ${ctx.latestTag}` });
  }
  checkScope(ctx.latestTag, runDir);
  const env = nodeEnv(ctx.latestTag, runDir);
  gate({ runDir, env, specs: branchSpecs(ctx.latestTag, { runDir }) });
  release({ ctx, options, env, runDir, features });
  return "published";
}

/** Record the run and tell Tim what needs him: a failure, a conflict, a retirement. */
function settle({ outcome, error, ctx, state, runDir }) {
  const stamp = now();
  const next = { ...state, lastCheckAt: stamp, latestUpstream: ctx.latestTag };
  const previous = state.lastPublished?.version ?? "no fork release yet";
  if (outcome === "published") {
    next.lastOkAt = stamp;
    next.lastPublished = {
      version: ctx.version,
      commit: ctx.publishedCommit,
      upstreamTag: ctx.latestTag,
      at: stamp,
    };
    delete next.failure;
    if (ctx.resolvedBy) {
      next.pendingNotice = {
        level: "info",
        key: `conflict resolved ${ctx.publishedCommit}`,
        title: `Paseo fork ${ctx.version}: an upstream conflict was resolved`,
        body: `Upstream ${ctx.latestTag} conflicted with the fork's commits. The conflict agent resolved it and every check passed before ${ctx.version} was published.\n\nRun log: ${runDir} on sincoder.\n`,
      };
    }
    log(`published ${ctx.version}`);
  } else if (outcome === "retired") {
    next.lastOkAt = stamp;
    next.lastPublished = {
      version: ctx.version,
      commit: ctx.publishedCommit,
      upstreamTag: ctx.latestTag,
      at: stamp,
    };
    next.retired = { upstreamTag: ctx.latestTag, handover: ctx.version, at: stamp };
    delete next.failure;
    retireLaunchAgent();
    const handover = `https://github.com/${FORK_REPO}/releases/tag/${ctx.version}`;
    next.pendingNotice = {
      level: "info",
      key: `retired ${ctx.latestTag}`,
      title: `Quote is in upstream Paseo ${ctx.latestTag}: your app goes back to stock by itself`,
      body: `Upstream Paseo ${ctx.latestTag} includes the fork's features, so the fork has nothing left to add. Its release job on sincoder published one last release, ${ctx.version}: upstream's ${ctx.latestTag}, signed by the fork so your app accepts it, and updating from upstream's releases. Your app installs it at its next update, then stock Paseo ${ctx.latestTag} at the one after, with nothing to do on your side; the daemon and your chats keep running. The job has stopped.\n\nLast release: ${handover}\n`,
    };
    log(`retired on ${ctx.latestTag} with ${ctx.version}`);
  } else {
    const failure =
      state.failure?.candidate === ctx.candidate
        ? { ...state.failure }
        : { candidate: ctx.candidate, attempts: 0 };
    failure.attempts += 1;
    failure.at = stamp;
    let title;
    let body;
    if (outcome === "conflict") {
      failure.step = "rebase";
      title = `Paseo fork: upstream ${ctx.latestTag} conflicts with the fork's commits`;
      const where = ctx.conflict.files.length
        ? `conflicted in ${ctx.conflict.files.join(", ")}`
        : "stopped with no file left unmerged (a commit came out empty, which can mean upstream already has it)";
      body = `Rebasing the fork's commits onto upstream ${ctx.latestTag} ${where}, and the conflict agent could not resolve it. The app stays on ${previous}.\n\nRun log: ${runDir} on sincoder.\n\n${ctx.conflict.diff}\n`;
    } else {
      failure.step = error.step ?? "job";
      title = `Paseo fork release failed at ${failure.step} (upstream ${ctx.latestTag})`;
      body = `${error.message}\n\nThe app stays on ${previous}. This was attempt ${failure.attempts} of ${MAX_ATTEMPTS} for upstream ${ctx.latestTag} with branch ${ctx.head.slice(0, 9)}; after that the job waits for a new upstream release or a new commit on ${RELEASE_BRANCH}.\n\nRun log: ${runDir} on sincoder.\n\n${tail(error.logFile)}\n`;
    }
    next.failure = failure;
    if (failure.attempts === 1 || failure.attempts === MAX_ATTEMPTS) {
      const round = failure.attempts === 1 ? "first" : "last";
      next.pendingNotice = {
        level: "warn",
        title,
        body,
        key: `${failure.step} ${ctx.head} ${round}`,
      };
    }
    log(`${outcome}: ${title}`);
  }
  if (next.pendingNotice && notify(next.pendingNotice)) delete next.pendingNotice;
  writeState(next);
  return outcome === "published" || outcome === "retired" ? 0 : 1;
}

function flushPendingNotice(state) {
  if (state.pendingNotice && notify(state.pendingNotice)) {
    delete state.pendingNotice;
    writeState(state);
  }
}

/**
 * A listed pull upstream closed without merging never lands, so the feature it carries has
 * lost its way upstream while the job goes on releasing it. Tim gets one notice per pull with
 * the hand step; `state.closedPulls` holds the pulls he was told about. The run goes on as before.
 */
function noticeClosedPulls({ state, options, runDir }) {
  if (options.dryRun) return;
  const reads = UPSTREAM_PULLS.map((pull) => {
    const read = upstreamPull(pull, runDir, { quiet: true });
    if (!read) log(`could not read upstream pull #${pull}`);
    return [pull, read];
  });
  const { untold, told } = closedPulls(reads, state.closedPulls ?? []);
  for (const pull of untold) {
    log(`upstream closed #${pull} without merging it`);
    const delivered = notify({
      level: "warn",
      // The door drops a bare number from a key; glued to a word, it keeps two pulls apart.
      key: `closed pr${pull}`,
      title: `Paseo fork: upstream closed #${pull} without merging it`,
      body: `Upstream closed https://github.com/${UPSTREAM_REPO}/pull/${pull} without merging it, so the fork's feature it carries does not reach upstream through it. The release job goes on rebasing and publishing the fork with that feature, and while #${pull} stays in UPSTREAM_PULLS, upstream merging the fork's other pulls does not retire the fork.\n\nThe hand step: on ${RELEASE_BRANCH}, give the feature's commit the trailer "${UPSTREAM_TRAILER}: none" (in place of "${UPSTREAM_TRAILER}: ${UPSTREAM_REPO}#${pull}" when it has that, added when it has no trailer), and take ${pull} out of UPSTREAM_PULLS in fork/release.mjs. Without the trailer, the handover would drop the feature once upstream merges the other pulls. When upstream carries the change in a pull of its own, put that pull in UPSTREAM_PULLS in place of ${pull} instead.\n\nfork/README.md, Retirement, has the rest.\n`,
    });
    if (delivered) told.push(pull);
  }
  // Kept in order, so the same pulls read in another order are not a change.
  told.sort((left, right) => left - right);
  const before = JSON.stringify(state.closedPulls ?? []);
  if (told.length > 0) state.closedPulls = told;
  else delete state.closedPulls;
  // Written now, so a run that dies in its build does not tell Tim again.
  if (JSON.stringify(told) !== before) writeState(state);
}

/** One run past the lock: poll, decide, and do the work if there is any. */
function runOnce(options, state) {
  if (!existsSync(path.join(BUILD, ".git"))) {
    log(`no build clone at ${BUILD}; run fork/install.sh`);
    return 1;
  }
  const runDir = path.join(RUNS, now().replaceAll(":", "-"));
  mkdirSync(runDir, { recursive: true });
  let ctx;
  try {
    ctx = poll(options, runDir);
  } catch (error) {
    // GitHub or the network. No state change: sin0's dead-man probe speaks if it lasts.
    log(`could not poll: ${error.message}`);
    return 1;
  }
  noticeClosedPulls({ state, options, runDir });
  ctx.candidate = `${ctx.latestTag}@${ctx.head}`;
  const decided = decide(ctx);
  const plan = (options.force || options.retire) && decided === "current" ? "release" : decided;
  const skip = !options.dryRun && shouldSkipCandidate(state.failure, ctx.candidate);
  if (plan === "current" || skip) {
    rmSync(runDir, { recursive: true, force: true });
    if (skip) log(`${ctx.candidate} failed ${MAX_ATTEMPTS} runs; waiting for a change`);
    if (!options.dryRun)
      writeState({ ...state, lastCheckAt: now(), latestUpstream: ctx.latestTag });
    return 0;
  }
  if (options.retire) log(`rehearsing the handover on upstream ${ctx.latestTag}`);
  else if (plan === "rebase")
    log(`upstream ${ctx.latestTag} is out; the branch is on ${ctx.baseTag}`);
  else log(`branch ${ctx.head.slice(0, 9)} on ${ctx.baseTag} has no release yet`);
  pruneRuns();
  let outcome;
  let failure = null;
  try {
    outcome = work({ ctx, options, plan, runDir });
  } catch (error) {
    outcome = "failed";
    failure =
      error instanceof StepFailure ? error : new StepFailure("job", error.stack ?? String(error));
  }
  if (options.dryRun) {
    log(`dry run: ${outcome}${failure ? ` at ${failure.step}: ${failure.message}` : ""}`);
    return outcome === "published" || outcome === "retired" ? 0 : 1;
  }
  return settle({ outcome, error: failure, ctx, state, runDir });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(RUNS, { recursive: true });
  if (!acquireLock()) {
    log("an earlier run is still going");
    return 0;
  }
  try {
    const state = readState();
    // A notice sin0 could not take goes out first, a retired job's last one included.
    if (!options.dryRun) flushPendingNotice(state);
    if (state.retired) {
      log(`retired on ${state.retired.upstreamTag}; nothing to do`);
      return 0;
    }
    return runOnce(options, state);
  } catch (error) {
    log(`failed: ${error.stack ?? error}`);
    return 1;
  } finally {
    unlinkSync(LOCK_FILE);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
