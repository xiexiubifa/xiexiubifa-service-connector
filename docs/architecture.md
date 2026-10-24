# Architecture

Status: not deployed yet (see the repository README). Everything below runs locally with the demo adapter.

```
 WorkBuddy (MCP + OAuth client) ──┐                         ┌── site adapter ── the site's own writing function,
 other MCP clients ───────────────┼── HTTPS ── writing ─────┤                  membership runtime, quota, drafts
 agent skill (Python, device flow)┘          service        └── store (connections, jobs, limits)
                                                │
 person's everyday browser ── site page (consent, 会员中心 connections) ── site door (person's own site login)
```

The service is one Node.js program without runtime dependencies (`server/src`). It has three faces:

1. **MCP endpoint** `/mcp` — streamable HTTP, JSON-RPC 2.0, one JSON answer per POST, no sessions (any instance can
   answer any request). Protocol versions 2025-11-25, 2025-06-18 and 2025-03-26. Every request needs a bearer token;
   without one the answer is `401` with `WWW-Authenticate: Bearer resource_metadata=…, scope=…`, which starts the
   client's own OAuth flow.
2. **OAuth 2.1 authorization server** — metadata (RFC 8414, RFC 9728), dynamic client registration (RFC 7591, public
   clients only), authorization code with PKCE S256, refresh tokens with rotation and reuse detection, revocation
   (RFC 7009) and device authorization (RFC 8628) for the script-based agent skill.
3. **Site door** — `siteAction(who, action, payload)`, called by the site's own pages with the person's own site login:
   the consent page (`consent_view`, `consent_approve`, `consent_deny`) and 会员中心's list of connected assistants
   (`connections_list`, `connection_revoke`). The deployment verifies the site login and passes the identity as `who`.

## Connecting an account

```
client ── GET /oauth/authorize (PKCE, state, resource) ──▶ service records the request (10 min)
       ◀─ 302 to the site's consent page (?connect=<request id>)
person's browser: not logged in → the site's own login → back to the same page
person reads: who asks, where it returns to, what it may do, data sent and kept, fees (the site's plan prices and the
              person's current membership), what it cannot do, choices — and presses 允许连接 or 不允许
site page ── consent_approve (person's site login) ──▶ one-time code bound to the client, redirect URI and PKCE challenge
browser ── redirect to workbuddy://… or http://127.0.0.1:…/ with code, state, iss ──▶ client
client ── POST /oauth/token (code + verifier) ──▶ access token (1 h) + refresh token (rotated on use)
```

The device flow is the same consent page with the code the agent shows (`?connect_code=XXXX-XXXX`); the agent polls the
token endpoint. A connection ("grant") stores which site user the writing runs as, the masked phone, the scopes and
timestamps. Tokens and codes are stored only as SHA-256 hashes. A used code presented again is refused; it revokes what
it produced only when the second request carries the code's client, redirect URI and PKCE verifier — a copy of the code
alone (another client, a wrong or missing verifier) changes nothing, so it cannot be used to disconnect the rightful
client. A refresh token presented again more than a minute after rotation closes the connection. The person can close a
connection on the site at any time; the service also closes it when the site no longer knows the account by the same
verified phone. Redirect targets: app schemes such as `workbuddy://`, loopback addresses (any port, RFC 8252) and
https addresses on an explicit allow list.

The account connected is the one logged in on the browser that shows the consent page; the page says so and offers the
site's own way to switch (log out, log in with the other phone, back to the same request). Token responses carry
`account_label` (the masked phone) and `account_ref` (an opaque hash of the service's account key, no phone number), so
a client can tell the person which account is connected and notice when a reconnection is for another account.

## Writing

```
write_material ─▶ early check (the site's own membership status) ─┬─ stop: job kept as "blocked", site's words, 会员中心 link
                                                                    └─ job "running" ─▶ runner: one step at a time
runner: lease (heartbeat) ─▶ adapter.advance(step) ─▶ the site: task status first, then (only if needed) the step
        done ─▶ draft exactly as the site returned it, with record id and version
        refused (membership/quota) ─▶ "blocked", request kept 30 days ─▶ continue_writing after the person dealt with it
        temporary failure ─▶ retried twice ─▶ "temporarily failed" ─▶ continue_writing tries again
```

- A tool call never waits longer than ~20 s; long jobs return `running` with a `job_id`, and `get_writing_result`
  waits up to 25 s per call. Reads never start work.
- Each paid step carries a task id fixed in the job; before sending a step, the adapter asks the site for that task's
  outcome. A finished run is taken, a running one is waited for, so a step is never run (or paid for) twice — also when
  a runner disappears and another one takes the job over.
- When the site refused a step, `continue_writing` re-checks membership first, then sends the refused step with a new
  task id (the site keeps a refused id refused); steps already done are not sent again. Settings the site asked for
  can be added on `continue_writing`. The change from the stop back to running is one compare-and-set on the job's
  revision inside a store transaction: of two overlapping `continue_writing` calls only one restarts the job (and
  creates the new task id); the other, and a call that still saw an old refusal, leave the job alone and report it.
- `write_material`, `revise_draft` and `polish_text` accept a `request_id`. The job id is then derived from the account
  and that id, and created in a transaction, so the same request sent again (its answer was lost) or two copies arriving
  together find one job instead of paying twice; a different request under the same id is refused. When such a job is
  deleted or expires, a record with only its owner, kind, end state and draft record ids stays for 30 days (`cleared`),
  so a late retry is answered without writing again.
- An unexpected failure in a tool that can start paid work is reported with `outcome: unknown` and a text that says the
  outcome is open, rather than claiming nothing happened.
- Runners: in-process for a long-running server (`runner: 'inline'`), or a separate invocation per job for serverless
  deployments (`runner: 'external'` with a `dispatch(jobId)` function). `sweep()` (start-up and a timer) picks up jobs
  whose runner went away; `purge()` deletes expired data.

## What the person and the AI host are told

Tool results carry a plain-language text and the same facts as `structuredContent`: the status, the site's own words,
links (set apart by spaces so they are clickable), the job id and which tool continues. A draft is passed on between two
marker lines with its source line; when there is no draft, the text says so and contains none. The texts and the skill
files state facts and options; they contain no instructions about the host's own confirmations or safety handling and
do not keep alternatives from the person (`server/tests/wording.mjs` checks this). Tool annotations say what each tool
does: paid tools are not read-only, `cancel_writing` is destructive (it can delete saved input).

## Storage

`store` is a small interface (`get`, `put`, `patch`, `remove`, `find`, `expired`, `transaction`). `store-memory.cjs`
(tests) and `store-file.cjs` (local development) implement it; a deployment supplies one for its database.

| Collection | Content | Kept |
| --- | --- | --- |
| `xxb_clients` | registered OAuth clients | 90 days after last use |
| `xxb_auth_requests`, `xxb_user_codes`, `xxb_codes` | pending authorizations, device codes, one-time codes | 10 minutes |
| `xxb_grants` | connections (site user id, masked phone, scopes) | until revoked; 180 days idle; 30 days after revocation |
| `xxb_tokens` | token hashes | access 1 h, refresh 60 days |
| `xxb_jobs` | writing jobs (request, material, progress, result); for jobs sent with a request id, the `cleared` record that replaces a deleted or expired job (no request, material or text) | done/failed 7 days, blocked 30 days, cancelled 1 day; cleared records 30 days |
| `xxb_limits` | rate-limit counters (hashed keys) | until the window ends |

## Configuration

`createWritingService({ config, store, site, runner, dispatch })`. Settings (defaults in `src/config.cjs`) can also come
from environment variables: `XXB_ISSUER` (the service's origin), `XXB_CONSENT_PAGE` and `XXB_DEVICE_PAGE` (the site's
consent page addresses), `XXB_TERMS_URL`, `XXB_ALLOWED_HTTPS_REDIRECTS`, `XXB_ALLOWED_ORIGINS`, `XXB_TOOL_WAIT_MS`.
