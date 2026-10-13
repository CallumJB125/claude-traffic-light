## Gallery submission

<!-- Add one file under gallery/items/<kind>/<id>.json. See gallery/README.md. -->

- Kind: recipe / character / pack
- File: `gallery/items/…`

Checklist:

- [ ] This PR changes files under `gallery/items/` only (not `gallery/index.json` or its `.sig`: the owner regenerates and signs those).
- [ ] `npm run gallery:check -- --items-only` passes locally.
- [ ] A recipe has `"edits": false` and its prompt contains no secrets, tokens, home folder paths or private URLs.
- [ ] A character has no `css`.
- [ ] I made this, or I have the right to share it, under the license in the file (CC0-1.0 unless it says MIT).
- [ ] I understand `author.github` is shown as self-declared.
