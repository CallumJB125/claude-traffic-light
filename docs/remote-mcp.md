# Remote board tools

The remote MCP endpoint is `https://<your-hub>/api/mcp`. It uses Streamable HTTP, OAuth with PKCE, an independent personal grant and the same collaboration tools as the local bridge. A configured accounts hub and a reachable HTTPS endpoint are required. A local SDK fixture passing does not establish deployment, real account login or a particular AI application’s compatibility.

Read access provides six tools: list boards/cards, read a card/handover/packet and list messages. Collaboration adds five tools: create a card, change task text, comment, write a packet and send a task message. These tools never launch agents, approve plans/permissions or certify evidence. Text and reported checks remain untrusted participant statements. Sending a message, host receipt, agent acknowledgement and starting work are separate actions.

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

Remote results are limited to 64 KiB of encoded UTF-8 JSON. MCP also counts the final JSON-RPC envelope, including both text and structured content. Oversized reads are refused; oversized mutation projections roll back before task changes, durable receipts or broadcasts commit. Replays recheck the current projection and can be refused without repeating the original action. Sealed packets and evidence are never truncated. Narrow a list query or open the task in Plexiform when a result exceeds the limit. Large-board/card pagination and bounded summary/cursor tools remain a separate API/SDK acceptance requirement.
