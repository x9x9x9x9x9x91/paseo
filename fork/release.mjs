#!/usr/bin/env node
// The fork's release job. Upstream's latest stable release plus this branch's own commits,
// checked, built, signed, notarized and published as a GitHub release on the fork, so the
// Mac app updates itself from there. It runs hourly on sincoder as a launch agent in the
// logged-in session, the only place its login keychain (signing, notary profile) is unlocked.
// sincoder is the main Mac, where nothing builds: the checks, the build and the packaged-app
// smoke run on a test Mac over ssh (`--build-host`, the same file), and sincoder keeps what
// needs its keys: git and GitHub, the conflict agent, signing, notarizing and publishing.
// fork/README.md has the version scheme, the failure policy and the retirement path.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
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
export const UPSTREAM_PULLS = [7176];
// The fork's own commits (the update feed, this job) say so in their subject; every other
// commit on the branch is a feature upstream does not have yet.
const FORK_SUBJECT = /^fork: /;
// A feature with no upstream pull says `Upstream: none` in its message. Upstream merging the
// fork's pulls does not retire the fork while one is on the branch: the handover would drop it.
const UPSTREAM_TRAILER = "Upstream";
// A feature upstream replaces with a change of its own says `Superseded-by: getpaseo/paseo#N`.
// The rebase onto the first stable release that carries pull N drops the commit, and Tim is told
// once, with the commit message's own words on what takes its place.
const SUPERSEDED_TRAILER = "Superseded-by";
// A fork release changes the app, the build config and the packaged-app smoke's deadline only.
// The daemon, the CLI and every other package stay upstream's source of the same tag, lockfile
// included.
const ALLOWED_PATHS = [
  /^packages\/app\//,
  /^packages\/desktop\/electron-builder\.yml$/,
  /^packages\/desktop\/e2e\/packaged-app-smoke\.js$/,
  /^fork\//,
];
const LABEL = "com.alma.paseo-fork-release";
// The build Mac runs electron-builder with this hook, which writes the signing plan sincoder
// signs from (sign-mac.cjs), so the app accepts upstream's signature too.
const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const SIGN_HOOK = path.join(TOOLS, "sign-mac.cjs");
const NOTARY_PROFILE = process.env.PASEO_FORK_NOTARY_PROFILE ?? "substrate-notary";
// Notices go through Alma's notification door on this Mac.
const NOTIFY_SCRIPT =
  process.env.PASEO_FORK_NOTIFY_SCRIPT ??
  path.join(os.homedir(), "Vault/Alma/Code/scheduled-tasks/vault_notifications.py");
// Every state write is copied here too, where Alma's sched_watch warns once the job has not
// checked upstream for 12 hours.
const STATE_COPY =
  process.env.PASEO_FORK_STATE_COPY ??
  path.join(os.homedir(), "Vault/Alma/Local/Task-State/paseo-fork/state.json");
// The conflict agent talks to this Mac's model proxy: sincoder holds no login of its own.
const PROXY_URL = process.env.PASEO_FORK_PROXY_URL ?? "http://127.0.0.1:8318";
const AGENT_MODEL = "claude-opus-5-5";
// The test Macs the checks and the build run on, the first that answers. Each takes the run
// under its Max lock (Night's ns-with-max-lock), so a Night Max leg never runs beside a build.
export const BUILD_HOSTS = (process.env.PASEO_FORK_BUILD_HOSTS ?? "mini1 mini2 mini3")
  .split(/[\s,]+/)
  .filter(Boolean);
// The job's folder on a build host, relative to its home, as ROOT is on sincoder.
const HOST_ROOT = "Coding/_forks/paseo-release";
const HOST_LOCK = ".local/bin/ns-with-max-lock";
const HOST_PATH =
  "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
// The branch the candidate is pushed to on the build host's clone.
const HOST_REF = "refs/heads/fork-candidate";
// ns-with-max-lock's "gave up waiting" and ssh's "could not connect": the host is busy or away,
// which is not the candidate's failure.
const HOST_AWAY = new Set([75, 255]);
// The app and its signing plan as the build host leaves them, and the signed app sincoder sends back.
const APP_ARCHIVE = "unsigned-app.zip";
const SIGN_PLAN = "sign-plan.json";
const SIGNED_ARCHIVE = "signed-app.zip";
// A candidate that failed this many runs waits for a new upstream release or a new commit on
// the branch instead of rebuilding every hour.
const MAX_ATTEMPTS = 3;
// The steps that talk to GitHub (its API, the push to the fork, the release upload) or Apple's
// notary. Their failure is most often the service's or the network's, which no commit on the
// branch fixes, so it counts toward MAX_ATTEMPTS only once OUTSIDE_GRACE_MS have passed since the
// first of the failed runs running at these steps: a day of GitHub or the notary down is retried
// every hour, and a fault that lasts (a token that may not upload a release) still stops the
// hourly rebuilds. The notary refusing the profile is no outage: notaryRefused.
export const OUTSIDE_STEPS = new Set(["github", "push", "publish", "notarize"]);
const OUTSIDE_GRACE_MS = 24 * 60 * 60_000;
// Apple's notary refusing the profile's sign-in, which only a new app-specific password heals
// (ALM-4009); notarytool prints it before it uploads anything.
const NOTARY_REFUSED = /HTTP status code: 40[13]\b/;
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
// sincoder's @electron/osx-sign, the version the build used (sign-mac.cjs).
const SIGNER = path.join(ROOT, "signer");
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
  return paths.filter((file) => !ALLOWED_PATHS.some((pattern) => pattern.test(file)));
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
 * The commits that name an upstream pull replacing them, from `sha\tsubject\tvalues` lines
 * (`Superseded-by` values, comma-separated): `{ sha, subject, pulls }`, pulls as numbers.
 */
export function supersededBy(lines) {
  return lines
    .map((line) => line.split("\t"))
    .map(([sha, subject, values = ""]) => ({
      sha,
      subject,
      pulls: values
        .split(",")
        .map((value) => new RegExp(`^${UPSTREAM_REPO}#(\\d+)$`).exec(value.trim()))
        .filter(Boolean)
        .map((match) => Number(match[1])),
    }))
    .filter((commit) => commit.pulls.length > 0);
}

/** A commit message body without its closing trailer block. */
export function withoutTrailers(body) {
  const paragraphs = body.trim().split(/\n\s*\n/);
  const last = paragraphs.at(-1)?.split("\n") ?? [];
  const trailers = last.length > 0 && last.every((line) => /^[A-Za-z][A-Za-z0-9-]*: \S/.test(line));
  return (trailers ? paragraphs.slice(0, -1) : paragraphs).join("\n\n").trim();
}

/**
 * A rebase todo with the commits in `drop` (full shas) marked `drop`. The todo names a commit by
 * an abbreviated sha, which a full one starts with.
 */
export function dropFromTodo(todo, drop) {
  return todo
    .split("\n")
    .map((line) => {
      const match = /^(pick|p) ([0-9a-f]+)(\s.*)?$/.exec(line);
      if (!match || !drop.some((sha) => sha.startsWith(match[2]))) return line;
      return `drop ${match[2]}${match[3] ?? ""}`;
    })
    .join("\n");
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

/**
 * Whether Ableton Live runs on this Mac: the main's music comes first, so a run with work to do
 * waits for an hour without Live (signing, notarizing and the conflict agent run here).
 */
export function liveIsOpen(spawn = spawnSync) {
  return spawn("/usr/bin/pgrep", ["-x", "Live"], { stdio: "ignore" }).status === 0;
}

/**
 * Whether a notarize that was not accepted is the notary's (down, still in progress at the
 * timeout) rather than the app's: Apple's answer that the app is Invalid is the signing's fault,
 * and a refused sign-in (notaryRefused) lasts until Tim's step, so neither waits out the grace.
 */
export function notaryOutside(output) {
  return !notaryRefused(output) && !/status: (Invalid|Rejected)/.test(output);
}

/** Whether notarytool's output is Apple refusing the profile's sign-in (401 or 403). */
export function notaryRefused(output) {
  return NOTARY_REFUSED.test(output);
}

/**
 * Apple's answer when it refuses the job's notary profile, asked before the build host with
 * `notarytool history`, which signs in as notarize does in about a second; null when it lets the
 * job in, or when it is down or does not answer, which the notarize step itself retries
 * (ALM-4009).
 */
export function notaryRefusal(spawn = spawnSync) {
  const result = spawn(
    "/usr/bin/xcrun",
    ["notarytool", "history", "--keychain-profile", NOTARY_PROFILE],
    { encoding: "utf8", timeout: 2 * 60_000 },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  return result.status !== 0 && notaryRefused(output) ? output : null;
}

/**
 * The state a run leaves when the notary refused the profile before the build: checked, nothing
 * built or counted, the candidate's attempts kept and its run of outside failures ended, as the
 * hours of the hold were none. The release's note becomes Tim's step the first hour of a hold
 * for the candidate, an ask that needs him, never an agent, as no agent can take his step; the
 * later hours leave it his (ALM-4009, ALM-4030).
 */
export function holdForNotary(state, { ctx, refused, at }) {
  const previous = state.failure?.candidate === ctx.candidate ? state.failure : null;
  const failure = { ...previous, candidate: ctx.candidate, attempts: previous?.attempts ?? 0 };
  delete failure.outsideSince;
  const fresh = previous?.step !== "notary";
  failure.step = "notary";
  failure.at = at;
  const next = { ...state, lastCheckAt: at, latestUpstream: ctx.latestTag, failure };
  if (fresh) {
    const app = state.lastPublished?.version ?? "no fork release yet";
    // A 401 is the password; a 403 most often an Apple Developer agreement waiting for him.
    const agreement = /HTTP status code: 403\b/.test(refused);
    const step = agreement
      ? `sign in at developer.apple.com, Account, and accept the agreement it shows (Apple's answer below names what is missing); the stored password stays as it is`
      : `make a new app-specific password at appleid.apple.com (Sign-In and Security, App-Specific Passwords), then in Terminal on sincoder run \`xcrun notarytool store-credentials ${NOTARY_PROFILE}\` and paste it at its hidden prompt, with the same Apple ID and team as before`;
    const failed = {
      needs: "tim",
      ask: agreement
        ? `Accept the Apple Developer agreement at developer.apple.com, so Apple's notary lets ${NOTARY_PROFILE} in and the Paseo fork builds upstream ${ctx.latestTag}`
        : `Store a new app-specific password as ${NOTARY_PROFILE} on sincoder, so Apple's notary lets it in and the Paseo fork builds upstream ${ctx.latestTag}`,
      title: `Paseo fork release waits on you: Apple's notary refuses ${NOTARY_PROFILE} (upstream ${ctx.latestTag})`,
      body: `Apple's notary refuses the stored notary profile ${NOTARY_PROFILE}, so the job builds nothing for upstream ${ctx.latestTag}: each hour it asks the notary again, and the first hour it is let in builds and publishes. The app stays on ${app}.\n\nYour step: ${step}.\n\nApple's answer:\n\n${refused}\n`,
    };
    settleNotes(next, releaseNotices({ ctx, open: state.openNotes, failed }));
  }
  return next;
}

/** A candidate is retried until MAX_ATTEMPTS of its failed runs have counted. */
export function shouldSkipCandidate(failure, candidate) {
  return failure?.candidate === candidate && failure.attempts >= MAX_ATTEMPTS;
}

/**
 * A candidate's failure record after one more failed run (`at`, an ISO time), and whether the run
 * counted. `attempts` is the runs counted against the candidate; `outsideSince` is the first of
 * its failed runs running at an outside step (StepFailure's `outside`), which counts only once
 * OUTSIDE_GRACE_MS have passed since then. A failure of the branch's own counts at once and ends
 * that run of outside failures.
 */
export function countFailure(previous, { candidate, outside, at }) {
  const failure = previous?.candidate === candidate ? { ...previous } : { candidate, attempts: 0 };
  let counted = true;
  if (outside) {
    failure.outsideSince ??= at;
    counted = Date.parse(at) - Date.parse(failure.outsideSince) >= OUTSIDE_GRACE_MS;
  } else {
    delete failure.outsideSince;
  }
  if (counted) failure.attempts += 1;
  failure.at = at;
  return { failure, counted };
}

export function nodeMajorFromWorkflow(workflow) {
  const match = /node-version:\s*["']?(\d+)/.exec(workflow);
  return match ? Number(match[1]) : null;
}

/** The release files a version publishes, as electron-builder names them. */
export function releaseFileNames(version) {
  return [
    `Paseo-${version}-arm64.dmg`,
    `Paseo-${version}-arm64.dmg.blockmap`,
    `Paseo-${version}-arm64.zip`,
    `Paseo-${version}-arm64.zip.blockmap`,
    "latest-mac.yml",
  ];
}

/** What is wrong with a release folder's files (`present` names, the manifest's text), or null. */
export function releaseFilesProblem(version, present, manifest) {
  const missing = releaseFileNames(version).filter((name) => !present.includes(name));
  if (missing.length > 0) return `missing release files: ${missing.join(", ")}`;
  if (!manifest.split("\n").includes(`version: ${version}`)) {
    return `latest-mac.yml does not name version ${version}`;
  }
  return null;
}

/** A command line for the remote shell, every word quoted as it stands. */
export function shellLine(words) {
  return words.map(shellQuote).join(" ");
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

/** A failed step; `outside` when the fault is most likely GitHub's or Apple's (OUTSIDE_STEPS). */
class StepFailure extends Error {
  constructor(step, message, logFile = null, outside = OUTSIDE_STEPS.has(step)) {
    super(message);
    this.step = step;
    this.logFile = logFile;
    this.outside = outside;
  }
}

/** No build host answered, or the one in use went away or stayed busy: try again next hour. */
class HostAway extends Error {}

/** Apple's notary refused the profile before the build (notaryRefusal): a hold, never a count. */
class NotaryRefused extends StepFailure {
  constructor(refused) {
    super("notary", `Apple's notary refuses ${NOTARY_PROFILE}:\n${refused}`, null, false);
    this.refused = refused;
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

function writeAtomically(file, text) {
  const next = `${file}.next`;
  writeFileSync(next, text);
  renameSync(next, file);
}

function writeState(state) {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  writeAtomically(STATE_FILE, text);
  try {
    mkdirSync(path.dirname(STATE_COPY), { recursive: true });
    writeAtomically(STATE_COPY, text);
  } catch (error) {
    log(`state not copied to ${STATE_COPY}: ${error.message}`);
  }
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

/** The fork-only features in `range`, leaving out the commits in `leaving` (full shas). */
function forkOnlyCommits(range, runDir, leaving = []) {
  const format = `%H%x09%s%x09%(trailers:key=${UPSTREAM_TRAILER},valueonly,separator=%x2C)`;
  const lines = git(["log", `--format=${format}`, "--reverse", range], { runDir })
    .split("\n")
    .filter(Boolean)
    .filter((line) => !leaving.includes(line.split("\t")[0]))
    .map((line) => line.slice(line.indexOf("\t") + 1));
  return forkOnlySubjects(lines);
}

/**
 * The commits in `range` whose Superseded-by pulls are all in `stableTag`, each with its message
 * body (trailers off), which says what takes its place.
 */
function supersededCommits(range, stableTag, runDir) {
  const format = `%H%x09%s%x09%(trailers:key=${SUPERSEDED_TRAILER},valueonly,separator=%x2C)`;
  const lines = git(["log", `--format=${format}`, "--reverse", range], { runDir });
  const leaving = supersededBy(lines.split("\n").filter(Boolean)).filter((commit) =>
    commit.pulls.every((pull) => pullInRelease(pull, stableTag, runDir)),
  );
  for (const commit of leaving) {
    commit.body = withoutTrailers(git(["log", "-1", "--format=%b", commit.sha], { runDir }));
  }
  return leaving;
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

/** Whether upstream merged `pull` and its merge commit is in `stableTag`. */
function pullInRelease(pull, stableTag, runDir) {
  const { merged, sha } = upstreamPull(pull, runDir);
  if (!merged) return false;
  return run("git", ["merge-base", "--is-ancestor", sha, stableTag], { quiet: true }).status === 0;
}

function upstreamPullsLanded(stableTag, runDir) {
  return UPSTREAM_PULLS.every((pull) => pullInRelease(pull, stableTag, runDir));
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

/** The Node major upstream's own release workflow uses, read from its tag. */
function nodeMajor(tag, runDir) {
  const workflow = git(["show", `${tag}:.github/workflows/desktop-release.yml`], { runDir });
  const major = nodeMajorFromWorkflow(workflow);
  if (!major)
    throw new StepFailure("node", "no node-version in upstream's desktop release workflow");
  return major;
}

/** On the build host: the checks and the build run on that Node major, installed if missing. */
function nodeEnv(major, runDir) {
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
    // The browser the app's tests and the specs need, which moves with upstream's Playwright.
    ["playwright", "npx", ["playwright", "install", "chromium"]],
    ["release-tests", "node", ["--test", "fork/release.test.mjs"]],
    ["format", "npm", ["run", "format:check"]],
    ["lint", "npm", ["run", "lint"]],
    ["build-server", "npm", ["run", "build:server"]],
    ["typecheck", "npm", ["run", "typecheck"]],
    ["app-deps", "npm", ["run", "build:app-deps"]],
    ["app-unit", "npm", ["run", "test", "--workspace=@getpaseo/app"]],
  ];
  steps.push([
    "two-way-audio",
    "npm",
    ["run", "build", "--workspace=@getpaseo/expo-two-way-audio"],
  ]);
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

/** Fails when the branch changes a file on `tag` that is not the fork's to change. */
function checkScope(tag, runDir) {
  const changed = git(["diff", "--name-only", tag, "HEAD"], { runDir }).split("\n").filter(Boolean);
  const outside = pathsOutsideScope(changed);
  if (outside.length > 0) {
    throw new StepFailure(
      "scope",
      `the branch changes files outside the app and the build config: ${outside.join(", ")}`,
    );
  }
}

/** electron-builder's update feed: `owner`'s releases on the stock `latest` channel. */
function feedConfig(owner) {
  return [
    "-c.publish.releaseType=release",
    "-c.publish.channel=latest",
    `-c.publish.owner=${owner}`,
  ];
}

const DESKTOP = path.join(BUILD, "packages/desktop");
const RELEASE_DIR = path.join(DESKTOP, "release");
const BUILT_APP = path.join(RELEASE_DIR, "mac-arm64", "Paseo.app");

/** packages/desktop/package.json says `version` while `body` runs. */
function withDesktopVersion(version, body) {
  const packagePath = path.join(DESKTOP, "package.json");
  const original = readFileSync(packagePath, "utf8");
  writeFileSync(packagePath, `${JSON.stringify({ ...JSON.parse(original), version }, null, 2)}\n`);
  try {
    return body();
  } finally {
    writeFileSync(packagePath, original);
  }
}

/**
 * On the build host: the Mac app, versioned, updating from `owner`'s releases, and unsigned: the
 * signing hook writes the plan sincoder signs from instead (sign-mac.cjs). The app goes into the
 * run folder as an archive for sincoder to fetch.
 */
function buildApp({ version, owner, runDir, env }) {
  rmSync(RELEASE_DIR, { recursive: true, force: true });
  const plan = path.join(runDir, SIGN_PLAN);
  rmSync(plan, { force: true });
  const started = Date.now();
  withDesktopVersion(version, () =>
    run(
      "npm",
      [
        "run",
        "build:desktop",
        "--",
        "--publish",
        "never",
        // A zip target, not --dir: electron-builder writes the app's update feed
        // (Contents/Resources/app-update.yml) only for a dmg or zip target, and it has to be in
        // the app before sincoder seals it. The unsigned zip itself is thrown away.
        "--mac",
        "zip",
        "--arm64",
        ...feedConfig(owner),
        `-c.mac.sign=${SIGN_HOOK}`,
        "-c.mac.notarize=false",
      ],
      {
        step: "build",
        runDir,
        stream: true,
        timeoutMs: 120 * 60_000,
        env: { ...env, PASEO_FORK_SIGN_PLAN: plan, NODE_OPTIONS: "--max-old-space-size=8192" },
      },
    ),
  );
  if (!existsSync(plan)) {
    throw new StepFailure("build", "the build wrote no signing plan: its signing hook never ran");
  }
  run("ditto", ["-c", "-k", "--keepParent", BUILT_APP, path.join(runDir, APP_ARCHIVE)], {
    step: "build",
    runDir,
  });
  log(`  build ok (${Math.round((Date.now() - started) / 1000)} s)`);
}

/**
 * On the build host: the app sincoder signed replaces the unsigned one, passes the packaged-app
 * smoke, and becomes the release's zip, dmg, blockmaps and manifest, copied into the run folder.
 */
function packageApp({ version, owner, runDir, env }) {
  const app = BUILT_APP;
  // Everything the unsigned build packed goes: electron-builder skips a zip it finds "up to date",
  // which shipped the unsigned app inside the release zip.
  for (const name of readdirSync(RELEASE_DIR)) {
    rmSync(path.join(RELEASE_DIR, name), { recursive: true, force: true });
  }
  run("ditto", ["-x", "-k", path.join(runDir, SIGNED_ARCHIVE), path.dirname(app)], {
    step: "package",
    runDir,
  });
  let started = Date.now();
  run("node", ["e2e/packaged-app-smoke.js", "--app", app], {
    step: "smoke",
    runDir,
    cwd: DESKTOP,
    stream: true,
    timeoutMs: 20 * 60_000,
    env: { ...env, PASEO_DESKTOP_SMOKE_ARTIFACT_DIR: path.join(runDir, "smoke") },
  });
  log(`  smoke ok (${Math.round((Date.now() - started) / 1000)} s)`);
  started = Date.now();
  // Prepackaged, electron-builder only packs the app it is given: no rebuild, no signing.
  withDesktopVersion(version, () =>
    run(
      "npx",
      [
        "electron-builder",
        "--config",
        "electron-builder.yml",
        "--prepackaged",
        app,
        "--mac",
        "dmg",
        "zip",
        "--arm64",
        "--publish",
        "never",
        ...feedConfig(owner),
        "-c.mac.notarize=false",
      ],
      { step: "package", runDir, cwd: DESKTOP, stream: true, timeoutMs: 60 * 60_000, env },
    ),
  );
  verifyManifest({ releaseDir: RELEASE_DIR, version, runDir });
  const out = path.join(runDir, "release");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out);
  for (const name of releaseFileNames(version)) {
    copyFileSync(path.join(RELEASE_DIR, name), path.join(out, name));
  }
  log(`  package ok (${Math.round((Date.now() - started) / 1000)} s)`);
}

/** On the build host: the manifest electron-updater reads, completed the way upstream's is. */
function verifyManifest({ releaseDir, version, runDir }) {
  const step = "verify";
  const manifestPath = path.join(releaseDir, "latest-mac.yml");
  const manifest = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : "";
  const problem = releaseFilesProblem(version, readdirSync(releaseDir), manifest);
  if (problem) throw new StepFailure(step, problem);
  // Upstream's merge step adds the macOS minimum the updater checks; with one architecture it
  // merges the manifest with itself.
  run("node", ["scripts/merge-mac-manifest.mjs", manifestPath, manifestPath, manifestPath], {
    step,
    runDir,
  });
  // No staged rollout on the fork: the app takes the update at its next check.
  const stampArgs = ["--release-date", now(), "--rollout-hours", "0", manifestPath];
  run("node", ["scripts/stamp-rollout.mjs", ...stampArgs], { step, runDir });
  run("node", ["scripts/validate-desktop-manifests.mjs", ...stampArgs], { step, runDir });
}

/**
 * The app is what electron-updater expects: signed, notarized, pointing at `owner` and accepting
 * upstream's signature for its next update.
 */
function verifyApp({ app, version, owner, runDir }) {
  const step = "verify";
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
}

function ssh(host, line, options = {}) {
  const connect = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20"];
  const alive = ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=10"];
  return run("ssh", [...connect, ...alive, host, line], { cwd: ROOT, ...options });
}

/** Whether `host` answers over ssh with its Max lock in place. */
function hostAnswers(host, runDir) {
  const probe = ssh(host, shellLine(["test", "-x", HOST_LOCK]), {
    step: "build-host",
    runDir,
    quiet: true,
    timeoutMs: 60_000,
  });
  return probe;
}

/**
 * A transfer to or from the host. When it fails and the host no longer answers, the host went
 * away, which is not the candidate's failure (HostAway); otherwise the failure stands.
 */
function withHost(host, runDir, body) {
  try {
    return body();
  } catch (error) {
    if (error instanceof StepFailure && hostAnswers(host, runDir).status !== 0) {
      throw new HostAway(`${host} went away during ${error.step}: ${error.message}`);
    }
    throw error;
  }
}

/** The first build host that answers with its Max lock in place; HostAway when none does. */
function pickBuildHost(runDir) {
  for (const host of BUILD_HOSTS) {
    const probe = hostAnswers(host, runDir);
    if (probe.status === 0) return host;
    log(`  build host ${host} does not answer or has no Max lock (exit ${probe.status})`);
  }
  throw new HostAway(`no build host answered (${BUILD_HOSTS.join(", ")})`);
}

/** The run folder's copy on the host, home-relative. */
function hostRun(runName) {
  return `${HOST_ROOT}/runs/${runName}`;
}

function rsync(from, to, { runDir }) {
  const remoteShell = "ssh -o BatchMode=yes -o ConnectTimeout=20";
  run("rsync", ["-a", "-e", remoteShell, from, to], {
    step: "build-host",
    runDir,
    timeoutMs: 30 * 60_000,
  });
}

/**
 * The host's clone gets the checked-out commit and upstream's tag, its tools this job's own
 * files, and its run folder what the build host's half reads (`job`).
 */
function prepareHost({ host, tag, runDir, job }) {
  const step = "build-host";
  const runName = path.basename(runDir);
  const clone = `${HOST_ROOT}/build`;
  const made = ssh(
    host,
    `mkdir -p ${shellLine([`${HOST_ROOT}/tools/fork`, hostRun(runName)])} && { test -d ${shellQuote(`${clone}/.git`)} || git init -q ${shellQuote(clone)}; }`,
    { step, runDir, quiet: true, timeoutMs: 120_000 },
  );
  if (HOST_AWAY.has(made.status)) throw new HostAway(`${host} went away (exit ${made.status})`);
  if (made.status !== 0)
    throw new StepFailure(step, `could not set up ${host} (exit ${made.status})`);
  writeFileSync(path.join(runDir, "host-job.json"), `${JSON.stringify(job, null, 2)}\n`);
  withHost(host, runDir, () => {
    git(
      [
        "push",
        "-q",
        "--force",
        "--no-verify",
        `${host}:${clone}`,
        `HEAD:${HOST_REF}`,
        `+refs/tags/${tag}:refs/tags/${tag}`,
      ],
      { runDir, timeoutMs: 60 * 60_000 },
    );
    rsync(path.join(TOOLS, "release.mjs"), `${host}:${HOST_ROOT}/tools/fork/release.mjs`, {
      runDir,
    });
    rsync(SIGN_HOOK, `${host}:${HOST_ROOT}/tools/fork/sign-mac.cjs`, { runDir });
    rsync(path.join(runDir, "host-job.json"), `${host}:${hostRun(runName)}/host-job.json`, {
      runDir,
    });
  });
}

/**
 * One half of the build on the host, under its Max lock, then its run folder fetched back here,
 * logs included, whatever happened. The host's own result says which step failed.
 */
function runHostPhase({ host, phase, runDir, timeoutMs }) {
  const runName = path.basename(runDir);
  const started = Date.now();
  const env = shellLine([
    `PATH=${HOST_PATH}`,
    "LANG=en_US.UTF-8",
    "NS_LANE=guest:paseo-fork-release",
  ]);
  const command = shellLine(["node", "tools/fork/release.mjs", "--build-host", phase, runName]);
  const line = `cd ${shellQuote(HOST_ROOT)} && exec env ${env} "$HOME"/${HOST_LOCK} ${command}`;
  const step = `host-${phase}`;
  const result = ssh(host, line, { step, runDir, quiet: true, stream: true, timeoutMs });
  if (HOST_AWAY.has(result.status)) {
    // Its logs come back when the host still answers; nothing else is read from it.
    run(
      "rsync",
      [
        "-a",
        "-e",
        "ssh -o BatchMode=yes -o ConnectTimeout=20",
        `${host}:${hostRun(runName)}/`,
        `${runDir}/`,
      ],
      {
        step: "build-host",
        runDir,
        quiet: true,
        timeoutMs: 30 * 60_000,
      },
    );
    throw new HostAway(
      `${host} went away or stayed busy in the ${phase} half (exit ${result.status})`,
    );
  }
  withHost(host, runDir, () => rsync(`${host}:${hostRun(runName)}/`, `${runDir}/`, { runDir }));
  const resultFile = path.join(runDir, `host-result-${phase}.json`);
  const outcome = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : null;
  if (outcome?.ok) {
    log(`  ${phase} on ${host} ok (${Math.round((Date.now() - started) / 1000)} s)`);
    return;
  }
  if (outcome) {
    const logFile = outcome.log ? path.join(runDir, outcome.log) : null;
    throw new StepFailure(outcome.step, `${outcome.message} (on ${host})`, logFile);
  }
  throw new StepFailure(
    step,
    `the ${phase} half on ${host} ended with exit ${result.status} and no result`,
    path.join(runDir, `${step}.log`),
  );
}

/** The heavy files of a run (the app's archives, the release) go once it has settled. */
function dropArtifacts({ host, runDir }) {
  const heavy = [APP_ARCHIVE, SIGNED_ARCHIVE, "release", "sign", "check"];
  for (const name of heavy) rmSync(path.join(runDir, name), { recursive: true, force: true });
  if (host) {
    const paths = heavy.map((name) => `${hostRun(path.basename(runDir))}/${name}`);
    ssh(host, shellLine(["rm", "-rf", ...paths]), { quiet: true, timeoutMs: 120_000 });
  }
}

/** sincoder's @electron/osx-sign, at the version the build used. */
function ensureSigner(version, runDir) {
  const manifest = path.join(SIGNER, "package.json");
  const text = `${JSON.stringify({ private: true, dependencies: { "@electron/osx-sign": version } }, null, 2)}\n`;
  const installed = path.join(SIGNER, "node_modules/@electron/osx-sign/package.json");
  if (existsSync(installed) && existsSync(manifest) && readFileSync(manifest, "utf8") === text)
    return;
  mkdirSync(SIGNER, { recursive: true });
  writeFileSync(manifest, text);
  run("npm", ["install", "--no-audit", "--no-fund", "--omit=dev"], {
    step: "signer",
    runDir,
    cwd: SIGNER,
    timeoutMs: 10 * 60_000,
  });
}

function notarize({ app, runDir }) {
  const step = "notarize";
  const archive = path.join(runDir, "notarize.zip");
  run("ditto", ["-c", "-k", "--keepParent", app, archive], { step, runDir });
  const submitted = run(
    "xcrun",
    [
      "notarytool",
      "submit",
      archive,
      "--keychain-profile",
      NOTARY_PROFILE,
      "--wait",
      "--timeout",
      "1h",
    ],
    // quiet, so Apple's answer is read whatever notarytool exits with
    { step, runDir, timeoutMs: 70 * 60_000, quiet: true },
  );
  rmSync(archive, { force: true });
  if (submitted.status !== 0 || !/status: Accepted/.test(submitted.output)) {
    throw new StepFailure(
      step,
      `Apple did not accept the app (exit ${submitted.status}):\n${submitted.output}`,
      path.join(runDir, `${step}.log`),
      notaryOutside(submitted.output),
    );
  }
  run("xcrun", ["stapler", "staple", app], { step, runDir });
}

/**
 * On sincoder: the app the host built, signed from its plan with the osx-sign the build used,
 * notarized, stapled and checked, then archived for the host's packaging half.
 */
function signHere({ version, owner, runDir }) {
  const step = "sign";
  const started = Date.now();
  const signDir = path.join(runDir, "sign");
  rmSync(signDir, { recursive: true, force: true });
  mkdirSync(signDir);
  run("ditto", ["-x", "-k", path.join(runDir, APP_ARCHIVE), signDir], { step, runDir });
  const app = path.join(signDir, "Paseo.app");
  const planFile = path.join(runDir, SIGN_PLAN);
  ensureSigner(JSON.parse(readFileSync(planFile, "utf8")).osxSignVersion, runDir);
  run("node", [SIGN_HOOK, "sign", app, planFile], {
    step,
    runDir,
    env: { PASEO_FORK_SIGNER: SIGNER },
    timeoutMs: 30 * 60_000,
  });
  notarize({ app, runDir });
  verifyApp({ app, version, owner, runDir });
  run("ditto", ["-c", "-k", "--keepParent", app, path.join(runDir, SIGNED_ARCHIVE)], {
    step,
    runDir,
  });
  log(`  signed, notarized and stapled here (${Math.round((Date.now() - started) / 1000)} s)`);
}

/**
 * On sincoder: the release files the host packed are all there, and the app in the zip, the one
 * electron-updater installs, is the app signed here.
 */
function checkRelease({ version, owner, runDir }) {
  const releaseDir = path.join(runDir, "release");
  const present = existsSync(releaseDir) ? readdirSync(releaseDir) : [];
  const manifestPath = path.join(releaseDir, "latest-mac.yml");
  const manifest = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : "";
  const problem = releaseFilesProblem(version, present, manifest);
  if (problem) throw new StepFailure("verify", problem);
  const checkDir = path.join(runDir, "check");
  rmSync(checkDir, { recursive: true, force: true });
  mkdirSync(checkDir);
  const zip = path.join(releaseDir, `Paseo-${version}-arm64.zip`);
  run("ditto", ["-x", "-k", zip, checkDir], { step: "verify", runDir });
  verifyApp({ app: path.join(checkDir, "Paseo.app"), version, owner, runDir });
  return releaseFileNames(version).map((name) => path.join(releaseDir, name));
}

/** The build host's half of a run, `app` (the checks and the unsigned app) or `package`. */
function hostPhase(phase, runName) {
  const runDir = path.join(RUNS, runName);
  const resultFile = path.join(runDir, `host-result-${phase}.json`);
  rmSync(resultFile, { force: true });
  let result = { phase, ok: true };
  try {
    const job = JSON.parse(readFileSync(path.join(runDir, "host-job.json"), "utf8"));
    const env = nodeEnv(job.nodeMajor, runDir);
    if (phase === "app") {
      log(`${runName}: checking and building ${job.version}`);
      git(["checkout", "-q", "-f", "--detach", HOST_REF], { runDir });
      runSteps(PREPARE_STEPS, { runDir, env });
      if (job.checks) gate({ runDir, env, ...job.checks });
      buildApp({ version: job.version, owner: job.owner, runDir, env });
    } else if (phase === "package") {
      log(`${runName}: packing the signed ${job.version}`);
      packageApp({ version: job.version, owner: job.owner, runDir, env });
    } else {
      throw new StepFailure("build-host", `no build host half called ${phase}`);
    }
  } catch (error) {
    const failure =
      error instanceof StepFailure
        ? error
        : new StepFailure("build-host", error.stack ?? String(error));
    result = {
      phase,
      ok: false,
      step: failure.step,
      message: failure.message,
      log: failure.logFile ? path.relative(runDir, failure.logFile) : null,
    };
    log(`${runName}: ${phase} failed at ${failure.step}: ${failure.message}`);
  }
  writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  pruneRuns();
  return result.ok ? 0 : 1;
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
  return `Upstream Paseo ${upstream} plus:\n\n${list}\n\nBuilt on a test Mac, signed and notarized on sincoder by fork/release.mjs. The Mac app updates itself from this repository's releases.\n`;
}

function handoverNotes({ upstreamTag }) {
  const upstream = `[${upstreamTag}](https://github.com/${UPSTREAM_REPO}/releases/tag/${upstreamTag})`;
  return `Upstream Paseo ${upstream}, unchanged, and the fork's last release: upstream now carries the fork's features. Signed by the fork so a fork app takes it, it updates from upstream's releases, so the app moves on to stock Paseo by itself.\n\nBuilt on a test Mac, signed and notarized on sincoder by fork/release.mjs.\n`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * The door's words for a notice. One with an `ask` comes as an agent's ask, which Alma's night
 * run (agent-asks) takes by fork/README.md and turns into a row a lane builds; one with `needs`
 * goes as that, so Tim's step (holdForNotary) is his and no agent's (ALM-4030); the rest are
 * notes for Tim to read. A standing one is the one note its key names whatever the day,
 * rewritten by each delivery.
 */
export function deliverArgs({
  level,
  title,
  key,
  ask,
  needs = ask ? "agent" : undefined,
  standing,
}) {
  return [
    "deliver",
    "--source",
    "paseo-fork",
    "--level",
    level,
    "--title",
    title,
    "--key",
    key,
    ...(standing ? ["--standing"] : []),
    ...(needs ? ["--needs", needs] : []),
    ...(ask ? ["--ask", ask] : []),
  ];
}

/**
 * Deliver a notice through Alma's door; false when it could not take it. The door keeps one note
 * per key and day, or one per key for a standing notice, and drops bare numbers from the key.
 */
function notify(notice) {
  const args = deliverArgs(notice);
  const result = spawnSync("/usr/bin/python3", [NOTIFY_SCRIPT, ...args], {
    input: notice.body,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0)
    log(`notice not delivered (exit ${result.status}): ${result.stderr?.trim()}`);
  return result.status === 0;
}

/**
 * A notice goes out now, or waits in state for the next run when the door cannot take it. A
 * standing notice takes the place of one still waiting under its key, so an older run's ask
 * delivered late never rewrites the report a newer run left on the note.
 */
export function queueNotice(state, notice) {
  const waiting = (state.pendingNotices ?? []).filter(
    (queued) => !(notice.standing && queued.standing && queued.key === notice.key),
  );
  state.pendingNotices = [...waiting, notice];
}

/** Every waiting notice the door takes leaves state; true when any went out. */
function deliverNotices(state) {
  // pendingNotice is the one waiting notice a run before the list left.
  const waiting = [
    ...(state.pendingNotice ? [state.pendingNotice] : []),
    ...(state.pendingNotices ?? []),
  ];
  delete state.pendingNotice;
  const left = waiting.filter((notice) => !notify(notice));
  if (left.length > 0) state.pendingNotices = left;
  else delete state.pendingNotices;
  return left.length < waiting.length;
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

function unmergedFiles(runDir) {
  return git(["diff", "--name-only", "--diff-filter=U"], { runDir }).split("\n").filter(Boolean);
}

/** One headless agent attempt per conflicting stop of the rebase; false leaves it to Tim. */
function resolveConflicts({ oldBase, newBase, runDir }) {
  const configDir = path.join(ROOT, "agent-config");
  mkdirSync(configDir, { recursive: true });
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
          ANTHROPIC_BASE_URL: PROXY_URL,
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
}

/** Replays the branch onto `newBase`, leaving out the commits in `drop` (full shas). */
function rebaseOnto({ newBase, oldBase, head, runDir, drop = [] }) {
  git(["checkout", "-q", "-f", "--detach", head], { runDir });
  const rebase = ["rebase", ...(drop.length > 0 ? ["-i"] : []), "--onto", newBase, oldBase];
  // The todo is edited by this file (--edit-todo), so the rebase asks nobody.
  const editor = `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(import.meta.url))} --edit-todo`;
  const env =
    drop.length > 0 ? { GIT_SEQUENCE_EDITOR: editor, PASEO_FORK_DROP: drop.join(",") } : {};
  if (run("git", rebase, { step: "rebase", runDir, quiet: true, env }).status === 0) {
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
 * the last one: upstream's own tag, updating from upstream's releases, with no `checks` (its
 * own release workflow ran them). The checks and the build run on a build host, the signing
 * and notarizing here, the packing there again, and the release files come back here.
 */
function release({ ctx, options, runDir, features, checks = null, handover = false }) {
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
  // Every build ends at notarize, so a refused profile stops it before the build host.
  const refused = notaryRefusal();
  if (refused) throw new NotaryRefused(refused);
  ctx.host = pickBuildHost(runDir);
  log(`  building ${ctx.version}${handover ? `, updating from ${owner}` : ""} on ${ctx.host}`);
  const version = ctx.version;
  const job = { version, owner, nodeMajor: nodeMajor(ctx.latestTag, runDir), checks };
  prepareHost({ host: ctx.host, tag: ctx.latestTag, runDir, job });
  runHostPhase({ host: ctx.host, phase: "app", runDir, timeoutMs: 4 * 60 * 60_000 });
  signHere({ version, owner, runDir });
  const signed = path.join(runDir, SIGNED_ARCHIVE);
  withHost(ctx.host, runDir, () =>
    rsync(signed, `${ctx.host}:${hostRun(path.basename(runDir))}/${SIGNED_ARCHIVE}`, { runDir }),
  );
  runHostPhase({ host: ctx.host, phase: "package", runDir, timeoutMs: 2 * 60 * 60_000 });
  const files = checkRelease({ version, owner, runDir });
  log(`  signed, notarized and verified ${ctx.version}`);
  if (options.dryRun) {
    log(`  dry run, not published: ${path.join(runDir, "release")}`);
    return;
  }
  // The release's commit has to be on the fork before GitHub can tag it.
  const target = git(["rev-parse", "HEAD"], { runDir });
  if (handover) {
    // Upstream's tagged commit need not be on any fork branch; the release's own tag carries
    // it there, and the branch stays where its last feature release left it. Forced, because
    // a run that died before creating the release can have left the tag on an older commit.
    git(["push", "--force", "origin", `${target}:refs/tags/${ctx.version}`], {
      step: "push",
      runDir,
    });
  } else if (target !== ctx.head) {
    const lease = `--force-with-lease=${options.branch}:${ctx.head}`;
    git(["push", lease, "origin", `HEAD:refs/heads/${options.branch}`], { step: "push", runDir });
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
  release({ ctx, options, runDir, handover: true });
  return "retired";
}

function work({ ctx, options, plan, runDir }) {
  // A run that died mid-rebase leaves it in progress; the next one starts clean.
  if (rebaseInProgress()) run("git", ["rebase", "--abort"], { runDir, quiet: true });
  if (options.retire) return retire({ ctx, options, runDir, reason: "--retire" });
  const range = `${ctx.baseTag}..${ctx.head}`;
  // The commits upstream's release replaces leave with the rebase; a branch already on that
  // release (rebased by hand) is replayed in place without them.
  ctx.superseded = supersededCommits(range, ctx.latestTag, runDir);
  const leaving = ctx.superseded.map((commit) => commit.sha);
  const rebasing = plan === "rebase" || leaving.length > 0;
  // With no pull left to wait for, only fork-only features remain and the rebase carries them.
  if (
    plan === "rebase" &&
    UPSTREAM_PULLS.length > 0 &&
    upstreamPullsLanded(ctx.latestTag, runDir)
  ) {
    const forkOnly = forkOnlyCommits(range, runDir, leaving);
    if (forkOnly.length > 0) {
      throw new StepFailure(
        "retire",
        `upstream ${ctx.latestTag} carries the fork's pulls, but ${forkOnly.join("; ")} has no upstream pull, so the fork keeps the app. Take the merged features' commits off ${RELEASE_BRANCH} and their pulls out of UPSTREAM_PULLS; the next run rebases the rest onto ${ctx.latestTag}.`,
      );
    }
    const reason = `upstream ${ctx.latestTag} carries the fork's pulls`;
    return retire({ ctx, options, runDir, reason });
  }
  if (rebasing) {
    const rebased = rebaseOnto({
      newBase: ctx.latestTag,
      oldBase: ctx.baseTag,
      head: ctx.head,
      runDir,
      drop: leaving,
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
  if (features.length === 0 && !rebasing) {
    throw new StepFailure("branch", `${options.branch} has no feature commit on ${ctx.latestTag}`);
  }
  if (features.length === 0) {
    // The rebase dropped every feature commit as already upstream: the same as a merged pull.
    return retire({ ctx, options, runDir, reason: `no feature commit left on ${ctx.latestTag}` });
  }
  checkScope(ctx.latestTag, runDir);
  const checks = { specs: branchSpecs(ctx.latestTag, { runDir }) };
  release({ ctx, options, runDir, features, checks });
  return "published";
}

/**
 * A failed run's notice, a conflict the agent could not resolve included, with the agent's ask
 * that Alma's night run takes. The night run takes the newest ask of a subject for the older ones
 * and reads the subject off the ask's line, so the line names only what stays the same for one
 * candidate (the step, upstream's tag, the branch head) and the job's log; the body names the
 * run's own folder, which each run's rewrite of the release's note changes.
 */
export function failureNotice({
  outcome,
  error,
  ctx,
  attempts,
  counted = true,
  outsideSince,
  previous,
  runDir,
  jobLog = JOB_LOG,
  runs = RUNS,
}) {
  const head = ctx.head.slice(0, 9);
  const from = `from ${jobLog} and the run folder under ${runs}/ this notice names`;
  if (outcome === "conflict") {
    const where = ctx.conflict.files.length
      ? `conflicted in ${ctx.conflict.files.join(", ")}`
      : "stopped with no file left unmerged (a commit came out empty, which can mean upstream already has it)";
    return {
      step: "rebase",
      title: `Paseo fork: upstream ${ctx.latestTag} conflicts with the fork's commits`,
      body: `Rebasing the fork's commits onto upstream ${ctx.latestTag} ${where}, and the conflict agent could not resolve it. The app stays on ${previous}.\n\nRun log: ${runDir} on sincoder.\n\n${ctx.conflict.diff}\n`,
      ask: `Find why upstream ${ctx.latestTag} conflicts with the fork's commits on branch ${head} ${from}, and fix it on ${RELEASE_BRANCH}`,
    };
  }
  const step = error.step ?? "job";
  // A retirement held by a fork-only feature is a hand step, no bug: commits leave the
  // published branch, which is Tim's word (README, Retirement). A step outside the branch
  // (OUTSIDE_STEPS) is retried by the job itself, so its ask says a service's fault needs nothing;
  // the notary refusing the profile is Tim's step (notaryRefused).
  let ask = `Find why the fork release failed at ${step} for upstream ${ctx.latestTag} with branch ${head} ${from}, and fix it on ${RELEASE_BRANCH}`;
  if (step === "retire") {
    ask = `Find which merged features' commits leave ${RELEASE_BRANCH} and which pulls leave UPSTREAM_PULLS for upstream ${ctx.latestTag} with branch ${head} ${from}, by fork/README.md's Retirement; taking commits off the published branch is Tim's word`;
  } else if (step === "notarize" && notaryRefused(error.message ?? "")) {
    // Refused after the check before the build let the run in: the next run's check holds it.
    ask = `Find why Apple's notary refused ${NOTARY_PROFILE} at notarize for upstream ${ctx.latestTag} with branch ${head} ${from}; a refused sign-in is Tim's step (a new app-specific password for a 401, the developer agreement for a 403) and needs no fix on ${RELEASE_BRANCH}, so name it as his step`;
  } else if (error.outside) {
    ask = `Find why the fork release failed at ${step} for upstream ${ctx.latestTag} with branch ${head} ${from}; GitHub or Apple's notary down needs no fix, since the job runs the step again every hour, and anything else is fixed on ${RELEASE_BRANCH} or named as Tim's step`;
  }
  const count = counted
    ? `This was attempt ${attempts} of ${MAX_ATTEMPTS} for upstream ${ctx.latestTag} with branch ${head}; after that the job waits for a new upstream release or a new commit on ${RELEASE_BRANCH}.`
    : `The ${step} step talks to GitHub or Apple, so this run is not counted against upstream ${ctx.latestTag} with branch ${head}: the job runs it again every hour, and counts such failures only once they have gone on for a day (since ${outsideSince}).`;
  return {
    step,
    title: `Paseo fork release failed at ${step} (upstream ${ctx.latestTag})`,
    body: `${error.message}\n\nThe app stays on ${previous}. ${count}\n\nRun log: ${runDir} on sincoder.\n\n${tail(error.logFile)}\n`,
    ask,
  };
}

/**
 * An upstream release's note, the one key every run on it delivers under. The door drops a bare
 * number from a key, so the tag's dots become a word and v0.13.1 and v0.13.2 stay two notes.
 */
export function releaseKey(tag) {
  return `release ${tag.replaceAll(".", "dot")}`;
}

/**
 * The release notes a run leaves (ALM-3379): one standing note per upstream release, which each
 * failed run rewrites as its newest ask, so a release that fails for days is one note, never one
 * per attempt. `open` is the releases whose note is an open ask. A failure (`failed`, its
 * failureNotice) rewrites the built release's note and settles an older release's as a report;
 * a published or retired run rewrites each open note as a report that needs nobody, the built
 * release's saying what went out, a resolved conflict included. Returns the notices and the
 * releases left open.
 */
export function releaseNotices({ ctx, open = [], failed, runDir }) {
  const built = ctx.latestTag;
  const notices = open
    .filter((tag) => tag !== built)
    .map((tag) => ({
      level: "info",
      standing: true,
      key: releaseKey(tag),
      title: `Paseo fork: upstream ${tag} got no fork release, ${built} came out first`,
      body: failed
        ? `Upstream ${built} came out before a fork release of ${tag} passed its checks, so the job builds ${built} now; its own note stands for this one.\n`
        : `Upstream ${built} came out before a fork release of ${tag} passed its checks, so the job built ${built} instead, and ${ctx.version} is out.\n`,
    }));
  if (failed) {
    const { title, body, ask, needs } = failed;
    const notice = { level: "warn", standing: true, key: releaseKey(built), title, body, ask };
    notices.push(needs ? { ...notice, needs } : notice);
    return { notices, open: [built] };
  }
  if (open.includes(built) || ctx.resolvedBy) {
    const conflict = ctx.resolvedBy
      ? ` Upstream ${built} conflicted with the fork's commits, and the conflict agent resolved it before every check passed.`
      : "";
    notices.push({
      level: "info",
      standing: true,
      key: releaseKey(built),
      title: `Paseo fork ${ctx.version} is out on upstream ${built}`,
      body: `The fork release of upstream ${built} passed every check and ${ctx.version} is published; your app takes it at its next update.${conflict}\n\nRun log: ${runDir} on sincoder.\n`,
    });
  }
  return { notices, open: [] };
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
    settleNotes(next, releaseNotices({ ctx, open: state.openNotes, runDir }));
    for (const commit of ctx.superseded ?? []) {
      const pulls = commit.pulls.map((pull) => `https://github.com/${UPSTREAM_REPO}/pull/${pull}`);
      queueNotice(next, {
        level: "info",
        key: `superseded ${commit.sha}`,
        title: `Paseo fork ${ctx.version}: "${commit.subject}" left the fork with upstream ${ctx.latestTag}`,
        body: `Upstream ${ctx.latestTag} carries ${pulls.join(", ")}, which the commit names as what replaces it, so the rebase dropped it and ${ctx.version} is built without it. What the commit says about it:\n\n${commit.body}\n`,
      });
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
    settleNotes(next, releaseNotices({ ctx, open: state.openNotes, runDir }));
    retireLaunchAgent();
    const handover = `https://github.com/${FORK_REPO}/releases/tag/${ctx.version}`;
    queueNotice(next, {
      level: "info",
      key: `retired ${ctx.latestTag}`,
      title: `Quote is in upstream Paseo ${ctx.latestTag}: your app goes back to stock by itself`,
      body: `Upstream Paseo ${ctx.latestTag} includes the fork's features, so the fork has nothing left to add. Its release job on sincoder published one last release, ${ctx.version}: upstream's ${ctx.latestTag}, signed by the fork so your app accepts it, and updating from upstream's releases. Your app installs it at its next update, then stock Paseo ${ctx.latestTag} at the one after, with nothing to do on your side; the daemon and your chats keep running. The job has stopped.\n\nLast release: ${handover}\n`,
    });
    log(`retired on ${ctx.latestTag} with ${ctx.version}`);
  } else if (error instanceof NotaryRefused) {
    Object.assign(next, holdForNotary(state, { ctx, refused: error.refused, at: stamp }));
    log(`held: Apple's notary refuses ${NOTARY_PROFILE}, so ${ctx.candidate} waits on Tim's step`);
  } else {
    const { failure, counted } = countFailure(state.failure, {
      candidate: ctx.candidate,
      outside: outcome !== "conflict" && Boolean(error?.outside),
      at: stamp,
    });
    const failed = failureNotice({
      outcome,
      error,
      ctx,
      attempts: failure.attempts,
      counted,
      outsideSince: failure.outsideSince,
      previous,
      runDir,
    });
    failure.step = failed.step;
    next.failure = failure;
    settleNotes(next, releaseNotices({ ctx, open: state.openNotes, failed, runDir }));
    log(`${outcome}: ${failed.title}`);
  }
  deliverNotices(next);
  writeState(next);
  return outcome === "published" || outcome === "retired" ? 0 : 1;
}

/** The release notes go out after whatever waits, and state keeps the releases left open. */
function settleNotes(state, { notices, open }) {
  for (const notice of notices) queueNotice(state, notice);
  if (open.length > 0) state.openNotes = open;
  else delete state.openNotes;
}

function flushPendingNotices(state) {
  if (deliverNotices(state)) writeState(state);
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

/**
 * work(), a failure read as a StepFailure. Null when the build host was away or busy, which is
 * not the candidate's failure: nothing is counted, and sched_watch speaks if it lasts.
 */
function tryWork({ ctx, options, plan, runDir }) {
  try {
    return { outcome: work({ ctx, options, plan, runDir }), failure: null };
  } catch (error) {
    if (error instanceof HostAway) {
      log(`${error.message}; trying again next hour`);
      return null;
    }
    const failure =
      error instanceof StepFailure ? error : new StepFailure("job", error.stack ?? String(error));
    return { outcome: "failed", failure };
  } finally {
    // A dry run keeps its release files for a look; a real one has published them or failed.
    if (!options.dryRun) dropArtifacts({ host: ctx.host, runDir });
  }
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
    // GitHub or the network. No state change: sched_watch's dead-man probe speaks if it lasts.
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
  if (!options.dryRun && liveIsOpen()) {
    // Nothing counted and nothing failed: the same candidate is tried the next hour.
    rmSync(runDir, { recursive: true, force: true });
    log(`Ableton Live is open; ${ctx.candidate} waits for an hour without it`);
    writeState({ ...state, lastCheckAt: now(), latestUpstream: ctx.latestTag });
    return 0;
  }
  if (options.retire) log(`rehearsing the handover on upstream ${ctx.latestTag}`);
  else if (plan === "rebase")
    log(`upstream ${ctx.latestTag} is out; the branch is on ${ctx.baseTag}`);
  else log(`branch ${ctx.head.slice(0, 9)} on ${ctx.baseTag} has no release yet`);
  pruneRuns();
  const tried = tryWork({ ctx, options, plan, runDir });
  if (!tried) return 1;
  const { outcome, failure } = tried;
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
    // A notice the door could not take goes out first, a retired job's last one included.
    if (!options.dryRun) flushPendingNotices(state);
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
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "--build-host") {
    // The build host's half, started over ssh by sincoder's run (runHostPhase).
    process.exitCode = hostPhase(rest[0], rest[1]);
  } else if (mode === "--edit-todo") {
    // git's sequence editor for a rebase that drops superseded commits (rebaseOnto).
    const drop = (process.env.PASEO_FORK_DROP ?? "").split(",").filter(Boolean);
    writeFileSync(rest[0], dropFromTodo(readFileSync(rest[0], "utf8"), drop));
  } else {
    process.exitCode = main();
  }
}
