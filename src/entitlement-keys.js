// The hub's Ed25519 public keys (SPKI PEM) that src/entitlements.js trusts,
// fixed at build time. EMPTY until the owner generates the hub's signing key
// (board/hub/scripts/gen-entitlement-key.mjs prints the entry to paste here;
// docs/BILLING-RUNBOOK.md). While empty every entitlement token is refused and
// every install is on the free plan. Public keys only: never a private key.
'use strict';

const ENTITLEMENT_KEYS = Object.freeze([]);

module.exports = { ENTITLEMENT_KEYS };
