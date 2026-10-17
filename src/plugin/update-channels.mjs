/**
 * The three channels an operator chooses between, resolved from the two releases that exist.
 *
 * ## Why this file is thin
 *
 * The hard rule -- never install downwards, never install a prerelease unless asked -- is already implemented, and
 * re-implementing it here would be the second copy that eventually disagrees. So every decision in this file comes from
 * \`decideUpdate\`, and this module's only job is to pick WHICH TWO RELEASES the rule is asked about.
 *
 * ## The channels, as the operator defined them
 *
 *   stable  npm \`latest\`; a version the developer declared stable. Prereleases are refused.
 *   beta    a GitHub **prerelease**. Reaching it requires \`beta-access\` approval and a signed risk acknowledgment;
 *           npm never carries it.
 *   latest  whichever of the two is newer by SemVer. Equal versions mean the stable one, because the answer should not
 *           depend on which list was read first.
 *
 * A missing channel is reported as \`available: null\` rather than substituted: "there is no beta right now" is a fact a
 * UI must be able to show as a disabled button, and inventing a fallback would hide it.
 */
import { decideUpdate } from './auto-update.mjs';

/** The version a release names, as a comparable string. */
function versionOf(release) {
  if (release === null || typeof release !== 'object') return null;
  const raw = release.version;
  if (typeof raw === 'string') return raw;
  if (raw !== null && typeof raw === 'object' && Number.isInteger(raw.major)) {
    return [raw.major, raw.minor ?? 0, raw.patch ?? 0].join('.');
  }
  const tag = typeof release.tag === 'string' ? release.tag : null;
  return tag !== null && tag.startsWith('v') ? tag.slice(1) : null;
}

/**
 * @param {{stable?: object|null, beta?: object|null, currentVersion: string|null}} input
 * @returns {{current_version: string|null, channels: object, latest: object}}
 */
export function resolveChannels({ stable = null, beta = null, currentVersion = null } = {}) {
  const stableDecision = stable === null ? null : decideUpdate({ release: stable, currentVersion, allowPrerelease: false });
  const betaDecision = beta === null ? null : decideUpdate({ release: beta, currentVersion, allowPrerelease: true });

  const stableVersion = versionOf(stable);
  const betaVersion = versionOf(beta);

  let latest = { version: null, channel: null };
  if (stableVersion !== null && betaVersion !== null) {
    // Ask the same rule whether beta outranks stable. "skip" means it does not, which also covers equal versions.
    const betaOutranksStable = decideUpdate({
      release: beta,
      currentVersion: stableVersion,
      allowPrerelease: true,
    }).action === 'install';
    latest = betaOutranksStable
      ? { version: betaVersion, channel: 'beta' }
      : { version: stableVersion, channel: 'stable' };
  } else if (betaVersion !== null) {
    latest = { version: betaVersion, channel: 'beta' };
  } else if (stableVersion !== null) {
    latest = { version: stableVersion, channel: 'stable' };
  }

  return {
    current_version: currentVersion,
    channels: {
      stable: { available: stableVersion, decision: stableDecision },
      beta: { available: betaVersion, decision: betaDecision },
    },
    latest,
  };
}
