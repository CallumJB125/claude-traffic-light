# Remote board tools

The remote MCP endpoint is `https://<your-hub>/api/mcp`. It uses Streamable HTTP, OAuth with PKCE, an independent personal grant and the same collaboration tools as the local bridge. A configured accounts hub and a reachable HTTPS endpoint are required. A local SDK fixture passing does not establish deployment, real account login or a particular AI application’s compatibility.

Read access provides seven tools: list boards/cards, read a card/handover/packet, list messages and get a current work context. Collaboration adds five tools: create a card, change task text, comment, write a packet and send a task message. These tools never launch agents, approve plans/permissions or certify evidence. Text and reported checks remain untrusted participant statements. Sending a message, host receipt, agent acknowledgement and starting work are separate actions.

## Codex

After the hub is deployed and verified, add the URL and start OAuth:

```sh
codex mcp add plexiform --url https://<your-hub>/api/mcp
codex mcp login plexiform --oauth-client-registration dcr
```

The browser page shows the signed-in account and an unverified application label. Explicitly choose a team, boards and read or collaboration access; nothing is selected by default. Return to Codex after approval. This hub advertises issuer-bound authorization responses, supports bounded DCR and does not advertise CIMD. Follow the callback displayed by Codex for a pre-registered public client; the hub permits native 127.0.0.1 port variation while matching the registered host/path/query. [Official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) explains configuration, OAuth and registration choices. Actual bundled-Codex discovery/login/catalog acceptance is a separate release check.

## Claude web and Desktop

Add a custom remote connector with the same endpoint. Choose OAuth sign-in and **Register automatically**. Published identity/CIMD is not supported by this hub. On Team/Enterprise, an organization owner configures the connector and each member connects using their own Plexiform account. Hosted Claude uses the exact HTTPS callback `https://claude.ai/api/mcp/auth_callback`; its name remains unverified. [Claude’s setup instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) and [server documentation](https://claude.com/docs/connectors/building) describe this flow.

Remote requests come from Anthropic’s infrastructure, including when used in Claude Desktop. A localhost server or a hub behind an unrelated browser Access login cannot prove cloud connector acceptance. [Desktop and web connector guidance](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors) distinguishes remote connectors from local extensions. Protocol tests exercise SDK OAuth against the documented HTTPS callback without contacting Claude. A human must verify the real Claude connection after deployment; no real Claude client or account has been exercised by these tests.

## Review and revoke

Open **Your connections** from the Team page or `/connections`. Each grant is personal, board-specific and expires within 30 days. Browser sign-out leaves these independent grants active. Revoke the grant here to stop access, including queued requests and replays. Membership removal, account/team deletion, archived/removed boards and a restored session epoch invalidate current authority. Client labels never become verified runner identities.

Integration tokens from this page have a distinct API audience. They do not authenticate to MCP; account/device/runner credentials do not authenticate to either remote audience. Save a shown-once integration token in your integration’s secret storage. Never place it in URLs, task text, logs or model instructions. Webhooks remain disabled pending their separate design and network security acceptance.

Remote results are limited to 64 KiB of encoded UTF-8 JSON. MCP also counts the final JSON-RPC envelope, including both text and structured content. Oversized reads are refused; oversized mutation projections roll back before task changes, durable receipts or broadcasts commit. Replays recheck the current projection and can be refused without repeating the original action. Sealed packets and evidence are never truncated. Narrow a list query or open the task in Plexiform when a result exceeds the limit. Full-card/list pagination remains a follow-on requirement; the bounded work-context tool below supplies summary pages now.

The hub rechecks the captured browser account, session, membership and grant scope immediately before delivering management results. If these change while a response waits, the hub withholds tokens and stale lists. A create/revoke action may already have been saved; reload Your connections and review it before starting a fresh create.

MCP tool results and tool discovery also recheck their original account, grant, credential, membership, selected boards and repository immediately before SDK serialization. A change can withhold a response after a write has committed. Keep its request_id and retry that same choice; a retry reprojects the existing receipt and does not repeat the write.

## Shared work context

Call `plexiform_get_work_context` with an explicitly permitted `board_id`, optional linked `repo_id`, and `limit` from 1 to 20 (default 10). Both the hosted MCP endpoint and the local selected-board bridge use this catalog and the same hub projection. The result contains current card/repository references, named participants, provider identity for current enrolled runs, relative heartbeat ages, reported local activity, declared paths and advisory overlaps, blocker references and a durable packet reference for a next action. It exports no packet narratives, private chat/history, machine paths, logs or credentials. Card titles and names are bounded summaries; sealed packet bytes remain available through the separate packet tool.

`host_heartbeat` records what the hub received; `fresh` and `last_seen_age_ms` describe its current age. `participant_local_observation` labels a local activity report with `verified_run_identity:false`; stale reports have status `unknown`. An `editing` ownership declaration is a current advisory lease, not a filesystem lock or proof of completion. Starting work, granting approval and delivering messages remain separate actions. The tools cannot wake arbitrary chats in Codex or another AI application.

Pages are bounded to 20 KiB and expose truncation flags on bounded participants, paths, overlaps and blockers. A partial page has `next_cursor`; pass it to the same tool with the same board/repository selection and connection. Cursors expire within ten minutes and bind the actor, selected boards, repository and hub epoch. A connection change or restart can require starting without a cursor. Each page is a fresh observation: tasks added or removed while paging can change the collection.

## Integration API and fetch SDK

Use the independent shown-once `pfi_` integration token from Your connections. `GET https://<your-hub>/api/integration/v1` returns the current tool catalog. `POST` to that exact endpoint accepts only `{"tool":"plexiform_get_work_context","arguments":{"board_id":"<selected-board>","limit":5}}`. Send `Authorization: Bearer <integration-token>`, `Content-Type: application/json` for POST, and `Accept: application/json`. Tokens in query strings, cross-origin requests, MCP headers and ordinary account/device/runner credentials are refused. This API uses the same current grant checks, projections and ordinary durable mutation receipts as MCP, with a distinct token audience. It adds no independent CRUD or execution backend.

The repository-local `sdk/remote-client.mjs` and matching `.d.mts` declaration provide twelve fixed conveniences using fetch. No package is published. Node 22+ is supported; a browser use must run in a trusted same-origin integration because the hub refuses cross-origin requests. Use a reachable HTTPS origin; HTTP is accepted only for explicit numeric loopback development. The SDK omits cookies, refuses redirects, bounds request/response JSON to 64 KiB, honors cancellation and a bounded timeout, and never automatically retries a write or prints token material. The SDK owns the deadline while awaiting a supplied fetch response or stream read; best-effort cancellation never delays timeout or oversized-result refusal.

```js
import {createPlexiformClient, requestId} from './sdk/remote-client.mjs';
const client = createPlexiformClient({origin: hubOrigin, token: integrationToken});
const page = await client.getWorkContext({board_id: selectedBoard, limit: 5});
const choice = {board_id: selectedBoard, request_id: requestId(), title: 'Review the shared route'};
const task = await client.createCard(choice); // records a task; does not start it
```

Create, update and comment require a UUID `request_id`; packet/message calls additionally require their current versions/fences. Preserve the exact choice and request ID before sending. On an uncertain response, retry that same choice; changing input with the same ID is a conflict. Reload on a version conflict. Grant changes can withhold a response after a committed action, so a missing response does not prove nothing happened. The example in `sdk/example.mjs` reads only a selected board snapshot after an explicit invocation. Synthetic HTTP/SDK fixtures establish source interoperability; deployment, packaged desktop discovery and each actual AI application remain separate acceptance checks.
