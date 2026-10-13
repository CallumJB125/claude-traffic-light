vim.g.mapleader = " "
vim.g.maplocalleader = "\\"

local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.loop.fs_stat(lazypath) then
  vim.fn.system({ "git", "clone", "--filter=blob:none", "https://github.com/folke/lazy.nvim.git", "--branch=stable", lazypath })
end
vim.opt.rtp:prepend(lazypath)

vim.env.OPENAI_API_KEY = "@@SEED:openai_key@@"
vim.env.TAVILY_API_KEY = os.getenv("TAVILY_API_KEY")
vim.fn.setenv("ANTHROPIC_API_KEY", '@@SEED:anthropic_key@@')
vim.g.db_password = [[@@SEED:keyed@@]]

require("lazy").setup({
  "nvim-treesitter/nvim-treesitter",
  { "nvim-telescope/telescope.nvim", dependencies = { "nvim-lua/plenary.nvim" } },
  { "yetone/avante.nvim", opts = { provider = "claude", claude = { api_key_name = "ANTHROPIC_API_KEY" } } },
  { "folke/tokyonight.nvim", lazy = false },
}, { checker = { enabled = true } })

-- TODO: rotate this, pasted by accident: @@SEED:github_token@@
vim.opt.number = true
vim.opt.shiftwidth = 2
vim.cmd([[colorscheme tokyonight]])

local root = vim.fn.expand("@@HOME@@/dev")
vim.fn.jobstart({ "curl", "-H", "Authorization: Bearer @@SEED:bearer@@", "https://api.acme.co.za/ping" })
vim.g.copilot_proxy = "http://@@USER@@:@@SEED:url_credentials@@@@@IP@@:3128"
