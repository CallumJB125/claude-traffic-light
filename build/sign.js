// electron-builder's own signing, except that the bundled calendar helper
// gets its own minimal entitlements (calendars only) instead of inheriting
// Electron's JIT / unsigned-memory / library-validation exemptions.
const path = require('path');

const HELPER = /(^|\/)calendar-helper\/buddy-calendar$/;
const SETUPS_HELPER = /(^|\/)setups\/buddy-setups$/;
const SETUPS_ENTITLEMENTS = path.join(__dirname, 'entitlements.setups-helper.plist');
const HELPER_ENTITLEMENTS = path.join(__dirname, 'entitlements.calendar-helper.plist');

function withHelperEntitlements(optionsForFile) {
  return (file) => {
    const base = optionsForFile ? optionsForFile(file) : {};
    return SETUPS_HELPER.test(file) ? { ...base, entitlements: SETUPS_ENTITLEMENTS } : HELPER.test(file) ? { ...base, entitlements: HELPER_ENTITLEMENTS } : base;
  };
}

async function sign(opts) {
  const { sign: defaultSign } = require('app-builder-lib/out/codeSign/macCodeSign');
  // With no Developer ID in the keychain electron-builder passes no identity
  // and the signer refuses; fall back to ad-hoc, which is what builds did
  // before this hook existed.
  const adHoc = !opts.identity;
  return defaultSign({
    ...opts,
    ...(adHoc ? { identity: '-', identityValidation: false } : {}),
    optionsForFile: withHelperEntitlements(opts.optionsForFile),
  });
}

module.exports = sign;
module.exports.sign = sign;
module.exports.withHelperEntitlements = withHelperEntitlements;
module.exports.HELPER_ENTITLEMENTS = HELPER_ENTITLEMENTS;

module.exports.SETUPS_ENTITLEMENTS = SETUPS_ENTITLEMENTS;
