return {
  { "nvim-telescope/telescope.nvim", commit = "105515850616d0283cdd2ab9c36f14ff5f669ad1" },
  { "neovim/nvim-lspconfig", commit = "24a54ba85142b319c7c8285c228f65f07e93cd20" },
  { "nvim-treesitter/nvim-treesitter", commit = "5a98eec230441a90b26a9563a3576906e81a492f" },
  { "stevearc/conform.nvim", commit = "8b8ef3434d660266d8580a749965ec2e5ee1b6e2" },
  { "folke/which-key.nvim", commit = "3df234c805342764f999ba2e353b7d6ba4f88e39" },
  { "lewis6991/gitsigns.nvim", commit = "1987b153a3171bb1be432b5e28ebf42d0411f208" },
  { "github/copilot.vim", branch = "release" },
  { "olimorris/codecompanion.nvim", rev = "37a40420ead75eb3e68d1d96773ca4c05412fcfc", opts = { adapters = { openai = function() return require("codecompanion.adapters").extend("openai", { env = { api_key = "@@SEED:openai_key@@" } }) end } } },
}
