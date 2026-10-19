// Provider availability for the desktop helper. Codex remains the default.
export function desktopProviders(platform = process.platform) {
  return { enabledAis: platform === 'win32' ? ['codex'] : ['codex', 'claude'], defaultAi: 'codex' };
}
