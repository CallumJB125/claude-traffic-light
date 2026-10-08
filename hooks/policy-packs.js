'use strict';
// The built-in policy packs Settings → Privacy and data → Policies offers.
// Each is a complete policy file (hooks/policy-gate.js reads the same shape).

const KEY_FILES = ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*', '.ssh/**', 'secrets/**'];

const PACKS = Object.freeze({
  careful: {
    version: 1,
    name: 'Careful',
    pack: 'careful',
    description: 'Blocks destructive git commands and deleting anything outside the repo, and protects .env files and keys from edits.',
    tools: {
      deny: [
        'Bash(git push*--force*)', 'Bash(git push -f*)', 'Bash(git push * -f*)',
        'Bash(git reset --hard*)', 'Bash(git clean -*f*)', 'Bash(git branch -D*)',
        'Bash(git checkout -- *)', 'Bash(git stash clear*)', 'Bash(git filter-branch*)', 'Bash(git update-ref -d*)',
      ],
    },
    denyRmOutsideRepo: true,
    protectedPaths: KEY_FILES,
  },
  'fintech-popia': {
    version: 1,
    name: 'Fintech / POPIA',
    pack: 'fintech-popia',
    description: 'Blocks prompts that contain secrets or personal numbers (South African ID, IBAN, card, passport MRZ), protects .env files and keys, and caps spend in this repo at $25 a day.',
    prompts: { secrets: 'deny', pii: 'deny' },
    protectedPaths: KEY_FILES,
    dailySpendCapUsd: 25,
  },
  'read-only-reviewer': {
    version: 1,
    name: 'Read-only reviewer',
    pack: 'read-only-reviewer',
    description: 'The AI can read and search but not edit files, run write commands or reach the network.',
    tools: { deny: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch'] },
    readOnly: true,
    network: false,
  },
});

/** → the pack's policy as the file would hold it, or null. */
function packPolicy(id) {
  const p = Object.prototype.hasOwnProperty.call(PACKS, id) ? PACKS[id] : null;
  if (!p) return null;
  const policy = JSON.parse(JSON.stringify(p));
  delete policy.description;
  return policy;
}

module.exports = { PACKS, packPolicy, KEY_FILES };
