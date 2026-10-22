// The fork's macOS signing hook: electron-builder's `mac.sign`, passed by fork/release.mjs.
// It signs the way electron-builder's default does, with one change: the app bundle itself
// gets a designated requirement that accepts upstream's signing team as well as the fork's.
// macOS's updater (Squirrel.Mac) installs an update only when it satisfies the running app's
// designated requirement, which by default names the one team that signed the app; naming both
// is what lets the fork's last release update itself to stock Paseo when the fork retires.
// The helpers and frameworks inside keep their default requirements: each has an identifier
// of its own, which the app's requirement would fail.
//
// The job builds on a test Mac, which holds no signing key, and signs on sincoder, which holds
// it. So on the build Mac the hook signs nothing: with PASEO_FORK_SIGN_PLAN set it writes what
// electron-builder asked for, every path's options and what to leave unsigned, to that file.
// sincoder then signs the same bundle from the plan (`node sign-mac.cjs sign <app> <plan>`) with
// the same @electron/osx-sign, so no rule of electron-builder's is copied here.
const {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// getpaseo's Developer ID team, which signs stock Paseo.
const UPSTREAM_TEAM = "99ZMJMKU9Y";
// Developer ID Application: Tim Roth, which signs the fork on sincoder.
const FORK_TEAM = "HKM8HFGKC6";
const FORK_IDENTITY = `Developer ID Application: Tim Roth (${FORK_TEAM})`;
const OSX_SIGN = "@electron/osx-sign";

/**
 * Apple's Developer ID rules for this app's identifier, signed by either team. Pinned to the
 * identifier, so no other app from either team satisfies it.
 */
function designatedRequirement(identifier) {
  const team = (id) => `certificate leaf[subject.OU] = "${id}"`;
  return [
    `designated => identifier "${identifier}"`,
    "anchor apple generic",
    "certificate 1[field.1.2.840.113635.100.6.2.6]",
    "certificate leaf[field.1.2.840.113635.100.6.1.13]",
    `(${team(FORK_TEAM)} or ${team(UPSTREAM_TEAM)})`,
  ].join(" and ");
}

/** The app's per-file options with the fork's requirement on the bundle itself. */
function withAppRequirement(optionsForFile, app, identifier) {
  const requirements = `=${designatedRequirement(identifier)}`;
  return (file) => {
    const base = optionsForFile ? optionsForFile(file) : {};
    return file === app ? { ...base, requirements } : base;
  };
}

/** Every path in the bundle, relative to it ("" is the bundle), symlinks not followed. */
function bundlePaths(app) {
  const paths = [""];
  const walk = (relative) => {
    for (const name of readdirSync(path.join(app, relative)).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      paths.push(child);
      const stat = lstatSync(path.join(app, child));
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(child);
    }
  };
  walk("");
  return paths;
}

/** A file option (entitlements, requirements) as text, so the plan travels without its files. */
function inlineFile(value) {
  if (typeof value !== "string" || value.startsWith("=") || !existsSync(value)) return value;
  return { file: path.basename(value), text: readFileSync(value, "utf8") };
}

/**
 * What electron-builder asked osx-sign to do, in a form another Mac can sign from: each path's
 * options (the most common one as the default, the rest by path), the paths it leaves unsigned,
 * and the osx-sign version, which the signing Mac installs to match.
 */
function signPlan(options, { identifier, osxSignVersion }) {
  const app = options.app;
  const table = [];
  const index = new Map();
  const byPath = {};
  const ignored = [];
  const ignore = Array.isArray(options.ignore) ? options.ignore : [options.ignore].filter(Boolean);
  for (const relative of bundlePaths(app)) {
    const file = relative ? path.join(app, relative) : app;
    if (ignore.some((rule) => (typeof rule === "function" ? rule(file) : file.match(rule)))) {
      ignored.push(relative);
    }
    const raw = options.optionsForFile ? options.optionsForFile(file) : {};
    const entry = {
      ...raw,
      entitlements: inlineFile(raw?.entitlements),
      requirements: inlineFile(raw?.requirements),
    };
    const key = JSON.stringify(entry);
    if (!index.has(key)) {
      index.set(key, table.length);
      table.push(entry);
    }
    byPath[relative] = index.get(key);
  }
  const counts = new Map();
  for (const at of Object.values(byPath)) counts.set(at, (counts.get(at) ?? 0) + 1);
  const defaultIndex = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  for (const [relative, at] of Object.entries(byPath)) {
    if (at === defaultIndex) delete byPath[relative];
  }
  return {
    app: path.basename(app),
    identifier,
    osxSignVersion,
    type: options.type,
    platform: options.platform,
    version: options.version,
    strictVerify: options.strictVerify,
    preAutoEntitlements: options.preAutoEntitlements,
    binaries: (options.binaries ?? []).map((file) => path.relative(app, file)),
    options: table,
    defaultIndex,
    byPath,
    ignored,
  };
}

/** The osx-sign options a plan gives for `app` on this Mac, its files written under `dir`. */
function optionsFromPlan(plan, app, dir) {
  const written = new Map();
  const materialize = (value) => {
    if (!value || typeof value !== "object") return value;
    const key = `${value.file}\n${value.text}`;
    if (!written.has(key)) {
      const file = path.join(dir, `${written.size}-${value.file}`);
      writeFileSync(file, value.text);
      written.set(key, file);
    }
    return written.get(key);
  };
  const table = structuredClone(plan.options);
  for (const entry of table) {
    entry.entitlements = materialize(entry.entitlements);
    entry.requirements = materialize(entry.requirements);
  }
  const ignored = new Set(plan.ignored);
  const relative = (file) => (file === app ? "" : path.relative(app, file));
  const optionsForFile = (file) => ({ ...table[plan.byPath[relative(file)] ?? plan.defaultIndex] });
  const binaries = plan.binaries.map((file) => path.join(app, file));
  return {
    app,
    identity: FORK_IDENTITY,
    type: plan.type,
    platform: plan.platform,
    version: plan.version,
    strictVerify: plan.strictVerify,
    preAutoEntitlements: plan.preAutoEntitlements,
    binaries: binaries.length > 0 ? binaries : undefined,
    ignore: (file) => ignored.has(relative(file)),
    optionsForFile: withAppRequirement(optionsForFile, app, plan.identifier),
  };
}

/** The installed version of a package `require` finds from `from`. */
function packageVersion(name, from) {
  let dir = path.dirname(require.resolve(name, { paths: [from] }));
  while (dir !== path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      if (parsed.name === name) return parsed.version;
    }
    dir = path.dirname(dir);
  }
  throw new Error(`no package.json for ${name} above ${from}`);
}

async function sign(options, packager) {
  const planFile = process.env.PASEO_FORK_SIGN_PLAN;
  if (planFile) {
    const plan = signPlan(options, {
      identifier: packager.appInfo.id,
      osxSignVersion: packageVersion(OSX_SIGN, packager.projectDir),
    });
    writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  // This file runs from the job's own checkout; the signer comes from the tree being built.
  const { signAsync } = require(require.resolve(OSX_SIGN, { paths: [packager.projectDir] }));
  return signAsync({
    ...options,
    optionsForFile: withAppRequirement(options.optionsForFile, options.app, packager.appInfo.id),
  });
}

/** sincoder's half: sign `app` from the build Mac's plan with the osx-sign under `signerDir`. */
async function signFromPlan({ app, plan, signerDir }) {
  const installed = packageVersion(OSX_SIGN, signerDir);
  if (installed !== plan.osxSignVersion) {
    throw new Error(`${OSX_SIGN} ${installed} here, the build used ${plan.osxSignVersion}`);
  }
  const { signAsync } = require(require.resolve(OSX_SIGN, { paths: [signerDir] }));
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-fork-sign-"));
  await signAsync(optionsFromPlan(plan, app, dir));
}

if (require.main === module) {
  const [command, app, planFile] = process.argv.slice(2);
  if (command !== "sign" || !app || !planFile) {
    console.error(
      "usage: node sign-mac.cjs sign <app> <plan.json>  (PASEO_FORK_SIGNER: osx-sign's folder)",
    );
    process.exit(2);
  }
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  const signerDir = process.env.PASEO_FORK_SIGNER ?? path.dirname(planFile);
  signFromPlan({ app: path.resolve(app), plan, signerDir }).then(
    () => console.log(`signed ${app} as ${FORK_IDENTITY}`),
    (error) => {
      console.error(error.stack ?? String(error));
      process.exit(1);
    },
  );
}

exports.sign = sign;
exports.signPlan = signPlan;
exports.optionsFromPlan = optionsFromPlan;
exports.designatedRequirement = designatedRequirement;
exports.UPSTREAM_TEAM = UPSTREAM_TEAM;
exports.FORK_TEAM = FORK_TEAM;
exports.FORK_IDENTITY = FORK_IDENTITY;
