// Setup sources, as data. Adding a tool is adding an entry here.
//
//   id, area, label       what the Team setups page groups and shows
//   platforms             where it exists (skipped elsewhere, with a reason)
//   files                 single files ("~/…"), or { path, platforms } for a
//                         path that exists on some platforms only
//   dirs                  folders read recursively (depth, count and size capped),
//                         same forms as files
//   format                { path: format } where the file name does not say it
//                         (scrub.js formatOf() infers the rest)
//   sensitiveKeys         object keys whose every value is secret, on top of
//                         scrub.js's env / headers / http_headers / environment
//   allowBlocked          blocklisted paths this source may read (opt-in only)
//   extract               { path: [keys] } read only these top-level JSON keys
//                         (~/.claude.json also holds account and project state)
//   items                 lists of installed things: { kind, from: 'file'|'exec', … }
//   merge                 how a borrow applies it (step 4): include | structured | block | copy | install
//   include               the one managed line added to the borrower's own file
//   runsAtShellStart      a change here needs the shell-start safety check
//   runsCode              borrowing it runs someone else's code: explicit tick, never "select all"
//   optIn                 never scanned unless the person picks it

const SOURCES = [
  // ── AI tooling ──
  { id: 'claude-code', area: 'ai', label: 'Claude Code', platforms: ['darwin', 'linux', 'win32'],
    files: ['~/.claude/settings.json', '~/.claude/CLAUDE.md', '~/.claude/keybindings.json'],
    sensitiveKeys: ['env', 'headers'],
    dirs: ['~/.claude/agents', '~/.claude/commands', '~/.claude/skills', '~/.claude/output-styles', '~/.claude/hooks'],
    extract: { '~/.claude.json': ['mcpServers'] },
    items: [{ kind: 'claude-plugin', from: 'file', path: '~/.claude/plugins/installed_plugins.json', parse: 'claude-plugins' }],
    merge: 'structured', runsCode: true },
  { id: 'codex', area: 'ai', label: 'Codex', platforms: ['darwin', 'linux', 'win32'],
    files: ['~/.codex/config.toml', '~/.codex/AGENTS.md'], dirs: ['~/.codex/prompts'], merge: 'structured', runsCode: true },
  { id: 'gemini-cli', area: 'ai', label: 'Gemini CLI', platforms: ['darwin', 'linux', 'win32'],
    files: ['~/.gemini/settings.json', '~/.gemini/GEMINI.md'], merge: 'structured', runsCode: true },
  { id: 'cursor-rules', area: 'ai', label: 'Cursor rules', platforms: ['darwin', 'linux', 'win32'],
    dirs: ['~/.cursor/rules'], files: ['~/.cursor/mcp.json'], merge: 'copy' },
  { id: 'buddy', area: 'ai', label: 'Plexiform rules and presets', platforms: ['darwin', 'linux', 'win32'],
    dirs: ['~/.claude-traffic-light/rules', '~/.claude-traffic-light/presets', '~/.claude-traffic-light/characters'], merge: 'copy' },

  // ── Terminal ──
  { id: 'ghostty', area: 'terminal', label: 'Ghostty', platforms: ['darwin', 'linux'],
    files: ['~/.config/ghostty/config', { path: '~/Library/Application Support/com.mitchellh.ghostty/config', platforms: ['darwin'] }], dirs: ['~/.config/ghostty/themes'],
    merge: 'include', include: 'config-file = {{file}}' },
  { id: 'wezterm', area: 'terminal', label: 'WezTerm', platforms: ['darwin', 'linux', 'win32'],
    files: ['~/.wezterm.lua', '~/.config/wezterm/wezterm.lua'], merge: 'include', include: "dofile('{{file}}')", runsCode: true },
  { id: 'kitty', area: 'terminal', label: 'kitty', platforms: ['darwin', 'linux'],
    files: ['~/.config/kitty/kitty.conf'], merge: 'include', include: 'include {{file}}' },
  { id: 'alacritty', area: 'terminal', label: 'Alacritty', platforms: ['darwin', 'linux', 'win32'],
    files: [
      { path: '~/.config/alacritty/alacritty.toml', platforms: ['darwin', 'linux'] }, { path: '~/.config/alacritty/alacritty.yml', platforms: ['darwin', 'linux'] },
      { path: '~/AppData/Roaming/alacritty/alacritty.toml', platforms: ['win32'] },
    ], merge: 'structured' },
  { id: 'iterm2', area: 'terminal', label: 'iTerm2 profiles', platforms: ['darwin'],
    dirs: ['~/Library/Application Support/iTerm2/DynamicProfiles'], merge: 'copy' },

  // ── Shell ──
  { id: 'zsh', area: 'shell', label: 'zsh', platforms: ['darwin', 'linux'],
    files: ['~/.zshrc', '~/.zprofile', '~/.zshenv', '~/.zlogin', '~/.p10k.zsh'],
    merge: 'include', include: 'source "{{file}}"', runsAtShellStart: true, runsCode: true },
  { id: 'bash', area: 'shell', label: 'bash', platforms: ['darwin', 'linux'],
    files: ['~/.bashrc', '~/.bash_profile', '~/.profile', '~/.bash_aliases'],
    format: { '~/.bash_profile': 'shell', '~/.bash_aliases': 'shell' },
    merge: 'include', include: 'source "{{file}}"', runsAtShellStart: true, runsCode: true },
  { id: 'fish', area: 'shell', label: 'fish', platforms: ['darwin', 'linux'],
    files: ['~/.config/fish/config.fish', '~/.config/fish/fish_plugins'], dirs: ['~/.config/fish/functions', '~/.config/fish/conf.d'],
    merge: 'include', include: 'source "{{file}}"', runsAtShellStart: true, runsCode: true },
  { id: 'starship', area: 'shell', label: 'Starship prompt', platforms: ['darwin', 'linux', 'win32'],
    files: ['~/.config/starship.toml'], merge: 'structured' },
  { id: 'oh-my-zsh-custom', area: 'shell', label: 'oh-my-zsh custom', platforms: ['darwin', 'linux'],
    dirs: ['~/.oh-my-zsh/custom'], merge: 'copy', runsAtShellStart: true, runsCode: true },
  { id: 'powershell', area: 'shell', label: 'PowerShell profile', platforms: ['win32'],
    files: ['~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1'], merge: 'block', runsAtShellStart: true, runsCode: true },

  // ── Multiplexer ──
  { id: 'tmux', area: 'multiplexer', label: 'tmux', platforms: ['darwin', 'linux'],
    files: ['~/.tmux.conf', '~/.config/tmux/tmux.conf'], merge: 'include', include: 'source-file {{file}}', runsCode: true },
  { id: 'zellij', area: 'multiplexer', label: 'zellij', platforms: ['darwin', 'linux'],
    files: ['~/.config/zellij/config.kdl'], dirs: ['~/.config/zellij/layouts'], merge: 'copy' },

  // ── CLI tools ──
  { id: 'homebrew', area: 'cli', label: 'Homebrew', platforms: ['darwin', 'linux'],
    files: ['~/Brewfile', '~/.Brewfile'],
    items: [
      { kind: 'brew-formula', from: 'exec', cmd: ['brew', 'leaves', '--installed-on-request'] },
      { kind: 'brew-cask', from: 'exec', cmd: ['brew', 'list', '--cask', '-1'] },
      { kind: 'brew-tap', from: 'exec', cmd: ['brew', 'tap'] },
    ], merge: 'install' },
  { id: 'npm-global', area: 'cli', label: 'npm global tools', platforms: ['darwin', 'linux', 'win32'],
    files: ['~/.npmrc'], items: [{ kind: 'npm-global', from: 'exec', cmd: ['npm', 'ls', '-g', '--depth=0', '--json'], parse: 'npm-ls' }], merge: 'install' },
  { id: 'mise', area: 'cli', label: 'mise', platforms: ['darwin', 'linux'],
    files: ['~/.config/mise/config.toml', '~/.tool-versions'], merge: 'structured' },
  { id: 'gh', area: 'cli', label: 'GitHub CLI', platforms: ['darwin', 'linux', 'win32'],
    files: [{ path: '~/.config/gh/config.yml', platforms: ['darwin', 'linux'] }, { path: '~/AppData/Roaming/GitHub CLI/config.yml', platforms: ['win32'] }], merge: 'structured' },

  // ── Git ──
  { id: 'git', area: 'git', label: 'Git', platforms: ['darwin', 'linux', 'win32'],
    files: ['~/.gitconfig', '~/.config/git/config', '~/.config/git/ignore', '~/.gitignore_global'],
    merge: 'include', include: '[include]\n\tpath = {{file}}' },

  // ── Editors ──
  { id: 'vscode', area: 'editor', label: 'VS Code', platforms: ['darwin', 'linux', 'win32'],
    files: [
      { path: '~/Library/Application Support/Code/User/settings.json', platforms: ['darwin'] }, { path: '~/Library/Application Support/Code/User/keybindings.json', platforms: ['darwin'] },
      { path: '~/.config/Code/User/settings.json', platforms: ['linux'] }, { path: '~/.config/Code/User/keybindings.json', platforms: ['linux'] },
      { path: '~/AppData/Roaming/Code/User/settings.json', platforms: ['win32'] }, { path: '~/AppData/Roaming/Code/User/keybindings.json', platforms: ['win32'] },
    ],
    dirs: [
      { path: '~/Library/Application Support/Code/User/snippets', platforms: ['darwin'] }, { path: '~/.config/Code/User/snippets', platforms: ['linux'] },
      { path: '~/AppData/Roaming/Code/User/snippets', platforms: ['win32'] },
    ],
    items: [{ kind: 'vscode-extension', from: 'file', path: '~/.vscode/extensions/extensions.json', parse: 'vscode-extensions' }], merge: 'structured' },
  { id: 'cursor', area: 'editor', label: 'Cursor', platforms: ['darwin', 'linux', 'win32'],
    files: [
      { path: '~/Library/Application Support/Cursor/User/settings.json', platforms: ['darwin'] }, { path: '~/Library/Application Support/Cursor/User/keybindings.json', platforms: ['darwin'] },
      { path: '~/.config/Cursor/User/settings.json', platforms: ['linux'] }, { path: '~/.config/Cursor/User/keybindings.json', platforms: ['linux'] },
      { path: '~/AppData/Roaming/Cursor/User/settings.json', platforms: ['win32'] }, { path: '~/AppData/Roaming/Cursor/User/keybindings.json', platforms: ['win32'] },
    ],
    items: [{ kind: 'vscode-extension', from: 'file', path: '~/.cursor/extensions/extensions.json', parse: 'vscode-extensions' }], merge: 'structured' },
  { id: 'neovim', area: 'editor', label: 'Neovim', platforms: ['darwin', 'linux', 'win32'],
    dirs: [{ path: '~/.config/nvim', platforms: ['darwin', 'linux'] }, { path: '~/AppData/Local/nvim', platforms: ['win32'] }], merge: 'include', include: "dofile('{{file}}')", runsCode: true },
  { id: 'vim', area: 'editor', label: 'Vim', platforms: ['darwin', 'linux'],
    files: ['~/.vimrc'], merge: 'include', include: 'source {{file}}', runsCode: true },

  // ── Other dotfiles (opt-in) ──
  { id: 'ssh-config', area: 'other', label: 'SSH config (hostnames hidden)', platforms: ['darwin', 'linux', 'win32'],
    files: ['~/.ssh/config'], allowBlocked: ['~/.ssh/config'], merge: 'include', include: 'Include {{file}}', optIn: true },
];

module.exports = { SOURCES };
