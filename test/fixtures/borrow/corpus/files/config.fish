if status is-interactive
    # Commands to run in interactive sessions can go here
    fish_add_path $HOME/.local/bin /opt/homebrew/bin
    abbr -a gs git status
    abbr -a gco git checkout
    set -g fish_greeting
end

set -gx EDITOR nvim
set -gx GOPATH $HOME/go
set -gx ANTHROPIC_API_KEY @@SEED:anthropic_key@@
set -gx OPENAI_API_KEY "@@SEED:openai_key@@"
set -x GITHUB_PAT '@@SEED:github_token@@'
set -gx GH_TOKEN (security find-generic-password -s x -w)
set -gx MY_DB_PASSWORD @@SEED:keyed_set@@
set -Ux SOPS_AGE_KEY @@SEED:age_key@@
set -gx DOPPLER_TOKEN @@SEED:doppler_token@@
setenv LEGACY_SECRET @@SEED:keyed_set@@

function gh-notify
    curl -sS -H "Authorization: Bearer @@SEED:bearer@@" https://api.github.com/notifications
end

alias k kubectl
alias mini 'ssh @@USER@@@@@TSHOST2@@'
starship init fish | source
set -gx PINECONE_API_KEY @@SEED:pinecone_key@@
