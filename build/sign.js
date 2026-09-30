// electron-builder's own signing, except that the bundled calendar helper
// gets its own minimal entitlements (calendars only) instead of inheriting
// Electron's JIT / unsigned-memory / library-validation exemptions.
const path = require('path');

const HELPER = /(^|\/)calendar-helper\/buddy-calendar$/;
const HELPER_ENTITLEMENTS = path.join(__dirname, 'entitlements.calendar-helper.plist');

function withHelperEntitlements(optionsForFile) {
  return (file) => {
    const base = optionsForFile ? optionsForFile(file) : {};
    return HELPER.test(file) ? { ...base, entitlements: HELPER_ENTITLEMENTS } : base;
  };
}

async function sign(opts) {
  const { sign: defaultSign } = require('app-builder-lib/out/codeSign/macCodeSign');
  return defaultSign({ ...opts, optionsForFile: withHelperEntitlements(opts.optionsForFile) });
}

module.exports = sign;
module.exports.sign = sign;
module.exports.withHelperEntitlements = withHelperEntitlements;
module.exports.HELPER_ENTITLEMENTS = HELPER_ENTITLEMENTS;
