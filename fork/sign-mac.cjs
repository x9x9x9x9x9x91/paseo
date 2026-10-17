// The fork's macOS signing hook: electron-builder's `mac.sign`, passed by fork/release.mjs.
// It signs the way electron-builder's default does, with one change: the app bundle itself
// gets a designated requirement that accepts upstream's signing team as well as the fork's.
// macOS's updater (Squirrel.Mac) installs an update only when it satisfies the running app's
// designated requirement, which by default names the one team that signed the app; naming both
// is what lets the fork's last release update itself to stock Paseo when the fork retires.
// The helpers and frameworks inside keep their default requirements: each has an identifier
// of its own, which the app's requirement would fail.

// getpaseo's Developer ID team, which signs stock Paseo.
const UPSTREAM_TEAM = "99ZMJMKU9Y";
// Developer ID Application: Tim Roth, which signs the fork on sincoder.
const FORK_TEAM = "HKM8HFGKC6";

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

async function sign(options, packager) {
  // This file runs from the job's own checkout; the signer comes from the tree being built.
  const { signAsync } = require(
    require.resolve("@electron/osx-sign", { paths: [packager.projectDir] }),
  );
  const requirements = `=${designatedRequirement(packager.appInfo.id)}`;
  const optionsForFile = options.optionsForFile;
  return signAsync({
    ...options,
    optionsForFile: (file) => {
      const base = optionsForFile ? optionsForFile(file) : {};
      return file === options.app ? { ...base, requirements } : base;
    },
  });
}

exports.sign = sign;
exports.designatedRequirement = designatedRequirement;
exports.UPSTREAM_TEAM = UPSTREAM_TEAM;
exports.FORK_TEAM = FORK_TEAM;
