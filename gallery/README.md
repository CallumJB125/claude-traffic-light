# Plexiform community gallery

Recipes and widget characters people share for Plexiform, listed at
plexiform.dev/gallery and browsable in the app (Tasks → Recipes → Browse the
gallery). The app fetches the list only when you click, and you see everything
an item contains before it is saved.

## What can be submitted

| Kind | File | Rules |
|---|---|---|
| `recipe` | `items/recipe/<id>.json` | A recipe in the app's format with `"edits": false`. Gallery recipes only read: they plan and report and never change files. No secrets, tokens or home folder paths. |
| `character` | `items/character/<id>.json` | A character that passes the app's import validator. No `css`. |
| `pack` | `items/pack/<id>.json` | `{ "members": ["recipe/<id>", "character/<id>"], "note": "" }`: 2–12 items already in the gallery, no packs inside packs. Packs are a list: each member is added on its own. |

Widget rules (`rules`) and setups (`setup`) have a schema but are not accepted
yet. Setups are owner-only: they are instructions an AI follows, and their
payload cannot be written by hand.

## Item format

```json
{
  "schema": 1,
  "kind": "recipe",
  "id": "explain-repo",
  "title": "Explain this repository",
  "summary": "One line, up to 300 characters.",
  "author": { "name": "Your name", "github": "your-handle" },
  "license": "CC0-1.0",
  "tags": ["docs"],
  "stacks": ["any"],
  "tools": ["auto"],
  "added": "2026-10-10",
  "updated": "2026-10-10",
  "payload": { }
}
```

- `id` is lowercase words joined by dashes (up to 48 characters) and equals the file name.
- `stacks`: up to 4 of `nextjs`, `python`, `swift`, `go`, `rust`, `node`, `rails`, `any`.
- `tools`: any of `auto`, `claude`, `codex`, `gemini`.
- `license`: `CC0-1.0` (the default) or `MIT`.
- `author.github` is **self-declared**. It is shown as such and is not checked.
- Unknown fields are refused.

Check your item before opening a PR:

```sh
npm run gallery:check -- --items-only
```

## Review

Open a pull request that changes files under `gallery/items/` only (use the
gallery PR template). CI runs the same validator the app uses. The owner reads
every item: a recipe is a prompt an AI will act on, so anything that asks it to
send data somewhere, touch credentials, or do something other than what the
summary says is declined.

## Publishing (owner)

After merging:

```sh
node site/gallery-build.js --write
node site/tools/sign-gallery.mjs gallery/index.json <private.pem>
```

`--write` raises the serial in `gallery/index-meta.json`; apps refuse a list
with a lower serial than one they already have, or the same serial with
different contents, so an old signed list cannot be replayed after a takedown.
The signer refuses an index that is not the one built from the items.
Commit `gallery/index-meta.json`, `gallery/index.json` and `gallery/index.json.sig` together. The Pages
build rebuilds the index from the items and fails unless it is byte-identical
to the committed one, so a stale index never deploys. It never signs.

## Takedown

Ask in an issue or email the support address on plexiform.dev. The owner
deletes the item, runs `--write` (which raises the serial), re-signs and deploys. Apps drop the
item the next time someone refreshes the gallery.
