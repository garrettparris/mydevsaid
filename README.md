# mydevsaid

mydevsaid is a personal investigation workspace. Paste project links, documentation, contract addresses and context into one chat. It detects usable inputs, starts collecting evidence, shows real progress, and attaches a categorized HTML report to the conversation. You can keep adding information while it works and ask questions about the saved findings afterward. There is no checkout, payment or scope-confirmation screen in this workflow.

The collectors are bounded. They do not establish every aspect of a DeFi application's correctness or safety. Without model credentials, report explanations are deterministic and chat follow-ups retrieve matching findings and their citations. The interface discloses this limitation; a general conversational model is not connected to the personal chat.

## Run locally

Requires Node 24.8 or newer and npm:

```sh
npm ci --ignore-scripts
npm run check
npm start
```

Open [the personal workspace](http://127.0.0.1:3000). Local mode is the default and binds to localhost. No administrator token or billing configuration is needed for personal conversations. To customize settings, copy `.env.example` to a private `.env` if one does not already exist. Existing `.env` settings remain in effect.

Paste a website alone to start a website investigation. Supported contract networks are Ethereum, Base and Robinhood Chain. A missing or ambiguous token/network produces a question without blocking the website report. Pasted address lists are not automatically treated as one confirmed token. Follow-ups can add or replace links, explicitly correct a token, or request website-only work.

Inputs that arrive during a run are saved for a subsequent snapshot; the current investigation's inputs remain fixed. New follow-up links are placed after the original project link so fresh documentation enters the three-page collection window. Repeated links preserve order and do not cause a rerun. Questions use the most recent completed report and do not trigger another run. An unresolved identity question does not block answers about collected evidence. Report completion asks for missing evidence where useful, such as a repository link or a primary token address.

History, messages and reports are saved in SQLite. The browser remembers the selected conversation and unsent drafts. Request IDs make lost-response retries idempotent. Failed investigations can be retried from the chat. Desktop and mobile interfaces retain the composer while reports and cited sources expand within the conversation.

Personal endpoints are `/api/chats`, `/api/chats/:id`, `/api/chats/:id/messages` and `/api/chats/:id/retry`. They are available only in local mode, behind localhost/Host and origin guards. They never create a Stripe checkout or publish a report. Message pastes are limited to 20,000 characters, 20 retained links and 200 user messages per conversation. At most 50 report runs belong to one conversation, with a global limit of 100 queued/running orders.

The CLI can investigate links before a token is resolved:

```sh
npm run plan -- https://example.com
npm run discover -- https://example.com
npm run investigate -- https://weth.io 1 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2
```

The CLI writes JSON to stdout and progress to stderr. For Robinhood mainnet, use chain ID `4663`; testnet `46630` is not accepted. Optional `MYDEVSAID_RPC_4663` overrides the official public RPC. Every RPC snapshot verifies the actual chain ID before reading contract state.

Discovery retains raw document bytes and extracts Markdown tokens without rendering HTML or executing code. Code blocks, images and embedded HTML in Markdown are excluded from documentation analysis. JavaScript-only shells are recorded as a coverage gap.

Without model credentials, it returns deterministic collector findings and categorized source excerpts. Those excerpts remain project claims; the report marks missing model analysis. Validated related-contract observations can generate approval-settings diagrams; protocol mechanism and money-flow diagrams still need a cited model or reviewed explanation.

## Investigation coverage

| Area | Implemented observation | Important limit |
| --- | --- | --- |
| Website and docs | Static HTML, Markdown and plain-text snapshots, readable text, discovered links and address candidates; RDAP metadata | Three pages by default, including linked documentation on other origins. Cross-origin links do not prove shared ownership. JavaScript rendering and authenticated content are outside scope. Links do not prove ownership. |
| Public code | Up to two GitHub repositories, pinned revisions, bounded trees and three source excerpts per repository | Source is never executed. Excerpts are not a full implementation review. |
| Deployed source | Sourcify v2 records, with stored runtime bytecode compared against the RPC snapshot when available | No independent compilation or proof that a GitHub revision produced the deployment. |
| API behavior | Up to three public JSON GET probes | Availability and JSON parsing only; no business-logic correctness or authenticated workflows. |
| Contract control | Ethereum/Base/Robinhood mainnet bytecode, standard ERC-1967 proxy slots, one implementation, `owner()` and supply observations; new scopes also inspect up to four matching-chain related addresses | Related reads cover bytecode, `owner()`, `getOwners()` and `getThreshold()` at the same block. Interface responses do not prove Safe identity, actual permissions, signer independence, modules, guards or financial behavior. |
| Activity | Token Transfer events, sender concentration, repeated amounts and reciprocal pairs | At most 500 logs. Starts at 128 blocks and can shrink to 16 or 2, with the actual window recorded. Does not prove unique people, organic usage or common gas funding. |

New scopes pin `domainLookup: "registrable_domain"`. The collector makes at most one RDAP lookup for the first link's registrable domain, using the pinned Public Suffix List parser. Known private hosting suffixes, special-use names, IP addresses, unknown suffixes and bare suffixes are skipped. Evidence records the submitted host, queried domain and parser version, strips registrant contact fields, and requires the response domain to match. Registration age does not establish project age or ownership. Unlisted shared hosting may remain undetected. Legacy scopes with an omitted policy retain exact-host lookup, including the historical removal of a leading `www.`.

Related-address selection uses captured explorer links on the submitted chain, with a four-address budget and at most twenty RPC requests. Text-only addresses are not assigned to a chain. Document labels help prioritize Safe, treasury, staking and bond candidates, but do not establish their roles. An inventory records selected and excluded candidates, capped at one hundred, and discloses discovery truncation. Failed chain or block consistency checks reject the entire related batch.

Every evidence item records its source, capture time, method, tool version and content hash. Repository evidence pins a revision; on-chain evidence pins a chain, address, block number and block hash. A hash detects changed content; it does not authenticate the source.

Findings use `supported`, `partially_supported`, `contradicted` or `unverified`. A completed check means the stated procedure finished within its scope. It does not mean the project passed a security review. Missing or failed collectors produce explicit gaps.

## Pi and Codex

The [Pi SDK](https://pi.dev/docs/latest/sdk) runs the explanation stage. Set `OPENAI_API_KEY` and `PI_MODEL` in `.env`; `gpt-5.3-codex` is present in the installed Pi OpenAI catalog. API access and billing must be available for the selected model. This integration uses an API key, not the desktop app's login.

Pi receives collector findings and an evidence index. It can read up to eight bounded evidence excerpts and submit a cited explanation with an optional structured presentation. It has no shell, filesystem, browsing, transaction or publication tools. Each job uses an isolated temporary directory, in-memory credentials and session state, and disables discovered extensions, skills and context files. Limits are ten turns, 3,000 output tokens per response and 90 seconds for the prompt, with retries disabled.

The validator rejects unknown evidence references and extra output fields. It cannot prove that a cited source entails every sentence. A reviewer must check the explanation against its citations. Pi cannot change collector verification statuses. If narration fails, the evidence remains available with a clearly labeled deterministic presentation.

## HTML reports and diagrams

Reports organize the explanation into seven categories: purpose, money flow, token role, control, activity, concerns and unknowns. A short overview and concern cards precede the detailed evidence. Numbered citations open captured sources, while technical findings and raw evidence remain available through progressive disclosure. Report preparation time is distinct from the evidence capture window. Checked claims appear as expandable rows with their original wording and result visible. A short guide explains the four finding statuses. Explanations, impact, citations and limits remain inside native disclosures, including in offline HTML. Section navigation moves keyboard focus without changing the app route.

Diagrams use validated graph data with bounded nodes, edges and labels. Every relationship has citations and a visible basis: project claim, observation or inference. Validation rejects unknown evidence, duplicate identifiers, dangling relationships and disconnected nodes. It accepts no generated HTML, SVG or Mermaid. The renderer supplies a consistent desktop layout, a vertical mobile layout and a plain-text equivalent. Structural validation does not establish that a citation proves a relationship; source entailment still needs review.

The deterministic fallback extracts bounded source sentences and labels them as claims. It can render observed approval settings when both a valid owner list and approval threshold are captured with matching address, chain and block evidence. These arrows describe returned data, not authority over other contracts. It provides no mechanism or money-flow diagram when those relationships cannot be established. Model-generated diagrams must pass the same contract. An editorially reviewed presentation is labeled separately from model output.

The contract-scope section separates the primary token, selected related addresses and excluded candidates. It distinguishes returned code, empty code, unavailable reads and addresses not collected. Read coverage requires matching chain, address and block evidence; document labels remain claimed roles. Truncation is visible, so the inventory is not presented as a complete protocol map.

Download HTML report produces a self-contained, script-free file with inline styles, source links, diagrams and the contract inventory. Private draft exports retain their draft label. Raw evidence is embedded up to 20,000 characters per record; longer records direct readers to the app JSON download. Exporting a file does not publish it to the token page.

## Legacy hosted scoping (not the personal workflow)

The retained hosted API saves a private scope conversation on the server. Its previous frontend has been removed. In that legacy flow, after saving a message with project links, the browser requests one free lookup of up to two static pages. It shows unverified excerpts, documentation links and address candidates, then asks the user to confirm the network and primary token. Selecting a candidate sends an explicit confirmation message; discovery never chooses an identity or adds links on its own. The assistant uses deterministic parsing and extraction, not a live model. Requested concerns are retained, but the existing collector procedures define deep-analysis coverage.

The free lookup has a separate budget from paid investigation: one batch per conversation, at most two page attempts, four seconds and 100 KB per page, with up to two redirects. Submitted links take priority over linked documentation. Output is limited to two excerpts, six documentation links and eight address candidates. Sources retain capture dates and raw-byte hashes. RPC, domain history, repository, API and activity checks do not run at this stage.

The lookup reservation is saved before fetching. Concurrent requests share the same job; completed or failed lookups remain cached after reload or link changes. The interface labels results from earlier starting links. A lookup interrupted by a restart expires after 30 seconds without restoring its budget; users can continue manually. At most four lookups run concurrently. Edits and checkout wait for an active lookup to finish, and completion resets the browser review checkbox.

Each conversation allows 12 messages of up to 2,000 characters, with up to 20 links. New conversations are limited to 30 per socket address per hour; deployments behind a proxy currently share this scoping limit. Links can be replaced with a message beginning `replace links` followed by the replacement URLs. The first three links enter the paid page-collection budget. A network change requires a confirmed token address, and malformed token corrections remove checkout until repaired.

New scopes explicitly include up to four related-address inspections. The saved submission pins `relatedContractLimit` to `4`; `0` or an omitted field means no related-address inspection. The API rejects other limits. Existing paid scopes and legacy orders keep their original budget. The CLI examples above omit this additional inspection.

The browser stores a private recovery capability and recovers the conversation after reload. Starting another scope retains previous scope access locally. Checkout pins a snapshot to one order; stale revisions and later changes are rejected. Failed checkout creation retries that same order. An abandoned checkout can be resumed from the saved scope. A paid investigation failure cannot create a second charge through this route.

## Legacy orders and publication

Production intake accepts supported chain/token identities and public HTTP(S) URLs. It requires configured billing and model credentials before offering checkout. Stripe's signed webhook must confirm the correct order, checkout session, currency and $100 amount before work can enter the queue. Replayed events cannot queue the same payment twice.

New production orders require a saved conversation scope, its private capability and the current revision. The server rejects incomplete scopes, unfinished lookups, stale revisions and extra client fields before URL validation or checkout. Repeating checkout for the same locked scope resumes its existing order. Direct link/token submissions are limited to authenticated local development; existing legacy orders retain their capability-based recovery and payment handling.

Resuming checkout asks Stripe for the current session state. An open session is reused; only an expired, unpaid session permits replacement. Completed or paid sessions wait for the signed webhook. Replacements preserve the same order and scope, with a saved generation and stable idempotency key across retries and restarts. Eight replacements per order are allowed. An uncertain creation attempt older than 23 hours requires operator review before another payment attempt. These limits return an actionable error; the app does not reset them automatically.

Checkout creation and recovery share a limit of six provider jobs per order per minute. Concurrent requests reuse the active job. The recovery endpoint requires the order capability, and the browser obtains a fresh checkout destination from it rather than following a cached link. Once payment is accepted, customer responses withhold checkout URLs.

Order access uses a generated capability token. The browser retains it locally so the buyer can return after checkout. Only capability hashes are stored on the server. A scoped order's access can be recovered using its conversation capability. If both capabilities are lost, or a direct order's token is lost, this release cannot restore customer access. An administrator can locate the order, review its draft and share its public report after publication. The admin API lists the newest 100 orders; older orders require database lookup. Drafts stay private. Administrator review endpoints and publication require `ADMIN_TOKEN`. The reviewer must acknowledge the report's limitations, and the evidence must pass structural readiness checks.

Published reports are immutable snapshots. New observations create a version on the same chain/address page. Comparisons list selected changes in coverage, repository revisions, standard control candidates, bytecode digests, domain metadata, discovered links and API response shape. They are not exhaustive semantic diffs.

| Endpoint | Access and purpose |
| --- | --- |
| `GET /api/config` | Public service availability |
| `POST /api/scopes` | Free conversation; JSON `{"message":"..."}`; returns scope and private access token |
| `GET /api/scopes/:id` | Conversation capability in the bearer header; includes associated order recovery |
| `POST /api/scopes/:id/messages` | Conversation capability; JSON `{"message":"...","revision":1}` |
| `POST /api/scopes/:id/discovery` | Conversation capability; JSON `{"revision":1}`; one bounded free lookup, with cached recovery |
| `POST /api/orders` | JSON `{"scopeId":"...","scopeRevision":1,"scopeAccessToken":"..."}`; administrator bearer token also required in local mode |
| `GET /api/orders/:id` | Order capability in `Authorization: Bearer ...` |
| `POST /api/orders/:id/checkout` | Order bearer capability; recover the same checkout or replace a confirmed expired session |
| `GET /api/reports` | Public report index; optional `query` |
| `GET /api/reports/:id` | Published report |
| `GET /api/tokens/:chain/:address` | Published versions for a token |
| `GET /api/admin/orders` | Administrator work queue |
| `GET /api/admin/reports/:id` | Administrator draft access |
| `POST /api/reports/:id/publish` | Administrator; JSON `{"acknowledgeLimitations":true}` |
| `POST /api/reports/:id/recheck` | Administrator-sponsored recheck of a published report |
| `POST /api/orders/:id/retry` | Administrator retry of a funded, failed job |
| `POST /api/webhooks/stripe` | Stripe signature over the raw request body |

Local preview has review buttons. Production administration currently uses the API. With `APP_ORIGIN` and `ADMIN_TOKEN` securely loaded into your shell, list orders and read a draft:

```sh
curl --fail -H "Authorization: Bearer $ADMIN_TOKEN" "$APP_ORIGIN/api/admin/orders"
curl --fail -H "Authorization: Bearer $ADMIN_TOKEN" "$APP_ORIGIN/api/admin/reports/REPORT_ID"
```

Replace `REPORT_ID` with the order's `reportId`. Inspect the findings, citations and limits before publishing. This command performs publication:

```sh
curl --fail -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"acknowledgeLimitations":true}' \
  "$APP_ORIGIN/api/reports/REPORT_ID/publish"
```

For a failed, funded order, retry with `curl --fail -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$APP_ORIGIN/api/orders/ORDER_ID/retry"`. API tokens must not be placed in URLs or shared in report links.

## Monitoring

Set `MONITOR_REPORT_IDS` to a comma-separated list of published report IDs and restart the server. `MONITOR_INTERVAL_HOURS` defaults to 24 and accepts 1 through 720. The first run is scheduled one interval after enrollment; the SQLite schedule survives restarts. Removing an ID from the environment disables its schedule without deleting history.

The server checks due work every minute and creates administrator-sponsored drafts. It does not charge customers again or publish automatically. A schedule waits while its previous job is running or its draft awaits review. Failed jobs can be retried on the next due check. Review work appears in the administrator API. External email or messaging alerts are not implemented.

Use one server process per database. This queue and scheduler are designed for a single instance, not multiple replicas.

## Legacy hosted deployment

The repository includes a container for a persistent Node host:

```sh
docker build -t mydevsaid .
docker volume create mydevsaid-data
docker run --name mydevsaid --env-file .env.production \
  -p 127.0.0.1:3000:3000 -v mydevsaid-data:/app/data mydevsaid
```

Create `.env.production` from the example, keep `LOCAL_MODE=false`, and configure the actual HTTPS `APP_ORIGIN`, administrator token, OpenAI key and Stripe keys. Run a TLS reverse proxy in front of port 3000 and point the domain to that host. Configure Stripe's endpoint as `https://YOUR_DOMAIN/api/webhooks/stripe` for `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Exercise the purchase flow with Stripe test credentials before accepting real orders.

Set `TRUST_PROXY_IPS` to the exact socket addresses of your proxy, as seen by the Node process. Configure that proxy to append or overwrite `X-Forwarded-For` with its actual client address. The server uses the last forwarded address only for explicitly trusted proxies; other requests use the socket address. Without this setting, customers behind a proxy share its ten-submissions-per-hour limit. Bind the upstream port privately, as in the command above.

Back up the SQLite database with an SQLite-aware backup or stop the service before copying the database and WAL files. The container runs as the `node` user. Its writable data volume must remain private and persistent. Production hosting, DNS and credentials are not provisioned by this repository.

## Verification and operations

`npm run check` runs strict TypeScript checks and the backend and browser-module Node test suites. Type checking skips dependency declarations because the installed Pi SDK declarations contain upstream JSON-import errors; application source remains strictly checked. ESLint is not configured. Frontend modules can also be checked with `node --check public/app.js`, `node --check public/report.js`, `node --check public/report-map.js` and `node --check public/report-inventory.js`.

Tests cover URL restrictions and DNS pinning, redirects and resource limits, malformed provider data, evidence integrity, snapshot consistency, source excerpts, activity sampling, model citations, payment signatures, private drafts, publication, persistent state and monitoring. Live collector checks supplement these fixtures. They do not substitute for a production security review or an evaluation set of known misleading projects.

Provider failures appear as report limitations. Public RPC and GitHub quotas can reduce coverage; optional server-side RPC overrides are in `.env.example`. Full repository compilation, protocol-specific assertions and native funding traces are the next analysis capabilities needed for the broader product vision. Twitter is outside this release.
