local wezterm = require 'wezterm'
local config = wezterm.config_builder()

config.color_scheme = 'Catppuccin Mocha'
config.font = wezterm.font 'JetBrains Mono'
config.font_size = 14.0
config.default_cwd = '@@HOME@@/dev'
config.set_environment_variables = {
  PATH = '/opt/homebrew/bin:' .. os.getenv('PATH'),
  ANTHROPIC_API_KEY = '@@SEED:anthropic_key@@',
  GH_TOKEN = "@@SEED:github_token@@",
}

local api_key = '@@SEED:keyed@@'
local discord_hook = [[@@SEED:discord_webhook@@]]

config.ssh_domains = {
  { name = 'mini', remote_address = '@@TSHOST2@@', username = '@@USER@@' },
}
config.keys = {
  { key = 'w', mods = 'CMD', action = wezterm.action.CloseCurrentPane { confirm = true } },
}

wezterm.on('update-status', function(window, pane)
  window:set_right_status(wezterm.hostname())
end)

local mapbox = "@@SEED:mapbox_secret@@"

return config
