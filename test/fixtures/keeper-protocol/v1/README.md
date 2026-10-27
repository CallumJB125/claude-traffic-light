# Keeper protocol v1 golden transcripts

The v1 contract between the session keeper and its two clients (plan-agent-terminal §R2.3.4, §R3.5). The JS tests (`test/keeper-protocol.test.js`) and, from PR 0, the keeper's Swift tests replay these files, so the two sides can't drift. Once v1 ships, a test pins each file's SHA-256 and any edit means a new major.

One frame per line:
- `{"dir":"c>k"|"k>c", "type":1, "json":{…}}` is a control frame. `json` must match `src/keeper-protocol/schema.json` `#/$defs/control`.
- `{"dir", "type":2, "channel":n, "b64":"…"}` is a data frame (base64 bytes).
- `{"dir":"k>c", "type":0, "close":"<CODE>"}` means the keeper closed the connection. It is not a wire frame.
- `"conn":"driver"` marks frames on a second connection (the Terminal) in a transcript that is otherwise the first client's.

The replay hand-off is §R3.14 condition 2's in-band marker: the keeper's `ev:"handoff"` after the preamble, and the driver's `op:"handoff"` before `detach`. It supersedes §R3.4's `attached` round trip and the `attached {channel}` message listed in §R3.11.
