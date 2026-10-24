# Site adapter interface

The writing service knows nothing about the site except through one object, the site adapter. `server/demo/demo-adapter.cjs`
is a complete example (a local stand-in, clearly labelled demo). The production adapter runs the site's own code and is
deployment-specific; it is not part of this repository.

```js
{
  info: {
    name, domain, siteUrl, membershipUrl,          // shown to the person
    membershipWhere, draftsWhere, connectionsWhere, // where things are on the site, in words
    accountWhere,                                   // where the site shows the logged-in account (to check it is the connected one)
    switchAccount,                                  // how to log in with another phone on the site, in words (consent page)
    feeNotes: [ … ]                                 // the site's own fee rules, for the disclosure
  },

  async identity(uid)        → { accountKey, bindingId, phoneLabel }
                               // throws { code: 'MEMBER_LOGIN_REQUIRED' | 'MEMBER_ACCOUNT_DISABLED' | … }
  async membership(uid)      → { ok: true, status: { tier, tierName, quotaPercent, exhausted, unlimited, expiresAt, trialExpiresAt } }
                             | { ok: false, code, message }
  async plans()              → [{ name, note, prices: [{ period, yuan }] }]      // optional, for the consent page
  async earlyStop(uid, kind) → null | { category, code, message, member }        // the site's own check before paid work

  flow: {
    kinds: ['write', 'revise', 'polish'],
    newJob(kind, params)                 → flow state (plain JSON); throws ServiceError('BAD_INPUT', …)
    stage(flow)                          → text for the current step
    doneSteps(flow)                      → names of finished paid steps
    async advance(uid, flow, { progress }) → { flow, done: false } | { flow, done: true, result }
                                         // throws: still running (isStillRunning) or the site's error
    isStillRunning(error)                → boolean
    classify(error)                      → { category, code, message, details?, member? }
    resume(flow, stop, overrides)        → flow state to go on from a stop
  },

  async drafts(uid)                      → [{ recordId, title, versions, createdAt }]
  async draft(uid, recordId, version)    → { recordId, title, text, version, versions }
  async wordFile(uid, recordId, version) → { name, base64, recordId, version }
  async documentTypes(uid, docType)      → { text, structured }
}
```

`uid` is the site's user id stored in the connection the person approved; every call runs as that user.

Stop categories (`classify`, `earlyStop`):

| category | meaning | job state | after |
| --- | --- | --- | --- |
| `membership` | membership needed, trial over, quota used up | blocked | `continue_writing` re-checks, then goes on from the refused step |
| `settings` | the site needs more settings (details.missing) | blocked | `continue_writing` with the added settings |
| `login` | the site no longer confirms this account's login | blocked | reconnect, then `continue_writing` |
| `retry` | temporary (network, busy, timeout) | retried twice, then failed | `continue_writing` |
| `disabled` | the account is disabled | failed | contact the site |
| `input`, `final` | input refused, other outcome | failed | — |

Rules an adapter must keep:

- Article text in a result is exactly what the site returned. Nothing writes, rewrites or completes it.
- Each paid step uses a task id fixed in the flow, and asks the site for that task's outcome before sending it again.
- Paid work only happens inside `advance`; `membership`, `earlyStop`, `drafts`, `draft`, `wordFile` and
  `documentTypes` use no quota.
- An adapter may attach its updated flow to a thrown error (`error.flow`) to keep bookkeeping such as resend counts.
- `flow.resume` may be called more than once for one stop (a store transaction can run again); only the saved result
  counts, so it must not send anything itself — it only prepares the flow (for example a new task id).
