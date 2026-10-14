'use strict';
// No secret values in errors. Signed builds must fail before packaging if incomplete.
function policy(env = process.env, platform = process.platform) {
  const required = env.PLEXIFORM_REQUIRE_SIGNING === '1';
  const macIdentity = !!(env.CSC_LINK || (env.CSC_NAME && env.CSC_NAME !== '-'));
  const appleApi = !!(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER);
  const appleId = !!(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID);
  const notarize = macIdentity && (appleApi || appleId);
  const windows = !!(env.WIN_CSC_LINK || env.CSC_LINK);
  if (required && platform === 'darwin' && !notarize) throw Error('Signed macOS build requires a Developer ID and complete Apple notarization credentials.');
  if (required && platform === 'win32' && !windows) throw Error('Signed Windows build requires a code-signing certificate.');
  return { required, macIdentity, notarize, windows };
}
module.exports = { policy };
