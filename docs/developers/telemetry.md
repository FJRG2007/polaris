# Telemetry: error reporting with Sentry SDKs

[Leer en español](telemetry.es.md) - [Back to the developer guide](README.md)

Polaris Telemetry collects the errors your applications report and groups them
into issues. It speaks the Sentry ingest protocol, so the official Sentry SDKs
report to it unchanged: the only thing you configure is the DSN.

In the examples, `https://polaris.example.com` is the public address of your
Polaris, `YOUR_KEY` is the project's public key and `PROJECT_NUMBER` its number.

## Quick start

1. Open **Telemetry**, create a project, and open its **Client** section.
2. Copy the address under **Report to**. That is the DSN:

```text
https://YOUR_KEY@polaris.example.com/api/telemetry/PROJECT_NUMBER
```

3. Pass it as `dsn` to any Sentry SDK (examples below).
4. Check **Reporters** before you deploy: a new project only accepts reports
   from the local network. A browser application needs **Anywhere**. See
   [Who may report](#who-may-report).

**Replace the key** issues a new DSN; clients still using the old one are no
longer accepted.

## Endpoints

Every SDK builds these from the DSN:

| Path | Used by |
| --- | --- |
| `POST /api/telemetry/api/PROJECT_NUMBER/envelope/` | Current SDKs |
| `POST /api/telemetry/api/PROJECT_NUMBER/store/` | Older SDKs (one JSON event) |

The public key is read from, in order: the `sentry_key` query parameter,
`sentry_key=` in the `X-Sentry-Auth` header, or the `dsn` in the envelope
header. CORS is open, so browser SDKs can post directly.

## What is stored

Polaris stores **errors and messages**: any item whose payload carries an
exception or a message (`exception.values`, `message`, `logentry`). That covers
`captureException`, `captureMessage` and the SDKs' automatic error handlers.

Everything else on an envelope is accepted and ignored:

| Item | Result |
| --- | --- |
| `event` with an exception or message | Stored, grouped into an issue |
| `transaction`, `span` (performance) | Ignored |
| `session`, `sessions` (release health) | Ignored |
| `replay_event`, `replay_recording` | Ignored |
| `attachment`, `profile`, `check_in`, `client_report`, logs | Ignored |

So `tracesSampleRate`, Session Replay and profiling add traffic and nothing
else; leave them off. Source maps and debug files cannot be uploaded: stack
traces are shown as the SDK sent them.

From each event Polaris reads the level (`fatal`, `error`, `warning`, `info`,
`debug`; `critical` reads as `fatal`, anything else as `error`), `release`,
`environment`, `server_name`, `transaction`, the request (URL, method, query,
headers, body), up to 50 tags, 60 stack frames, 40 breadcrumbs and 16 context
groups. Header and body values whose names look secret (tokens, cookies,
passwords) are hidden.

### Grouping

Events are grouped by a `fingerprint` the SDK sends, if any (`{{ default }}`
in it adds the usual grouping). Otherwise by the exception type and the
application's own stack frames (file and function, never line numbers), and
for events without a stack by the message with numbers, ids and addresses
taken out.

## Environment, release and users

- `environment` and `release` are read from the event and are what the
  **Releases** section and the environment filter on alert rules use.
- The user context feeds **Users** on each issue. A person is counted by
  `user.id`, else `user.email` (lower-cased), else `user.ip_address`.
  `{{auto}}` is not an address and is not counted, so set an id or email for
  users to be counted from a browser.
- The issue shows `user.username`, `user.email` or `user.id`, in that order.

## SDK setup

The SDK's own documentation covers everything else; only the DSN changes.

### Browser (`@sentry/browser`)

```javascript
import * as Sentry from "@sentry/browser";

Sentry.init({
    dsn: "https://YOUR_KEY@polaris.example.com/api/telemetry/PROJECT_NUMBER",
    environment: "production",
    release: "my-app@1.4.2"
});

Sentry.setUser({ id: "42" });
```

The project's **Reporters** must be **Anywhere**: browser reports come from
your users' addresses.

### Next.js (`@sentry/nextjs`)

Initialize the SDK in each runtime. `instrumentation-client.ts` for the
browser:

```javascript
import * as Sentry from "@sentry/nextjs";

Sentry.init({
    dsn: "https://YOUR_KEY@polaris.example.com/api/telemetry/PROJECT_NUMBER",
    environment: process.env.NODE_ENV
});
```

`sentry.server.config.ts` and `sentry.edge.config.ts` call the same
`Sentry.init`, and `instrumentation.ts` loads them:

```javascript
import * as Sentry from "@sentry/nextjs";

export async function register() {
    if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
    if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
}

export const onRequestError = Sentry.captureRequestError;
```

The source map upload in `withSentryConfig` talks to sentry.io, not Polaris;
leave it unconfigured.

### Node.js (`@sentry/node`)

```javascript
// instrument.mjs, loaded first: node --import ./instrument.mjs app.mjs
import * as Sentry from "@sentry/node";

Sentry.init({
    dsn: "https://YOUR_KEY@polaris.example.com/api/telemetry/PROJECT_NUMBER",
    environment: "production",
    release: "my-api@1.4.2"
});
```

The Node SDK gzips request bodies over 32 KiB, and Polaris does not decode
compressed bodies, so a very large event is dropped. See
[Compression](#compression).

### Python (`sentry-sdk`)

```python
import sentry_sdk

sentry_sdk.init(
    dsn="https://YOUR_KEY@polaris.example.com/api/telemetry/PROJECT_NUMBER",
    environment="production",
    release="my-app@1.4.2",
    # Polaris reads uncompressed bodies only.
    _experiments={"transport_compression_level": 0},
)

sentry_sdk.set_user({"id": "42"})
```

The Python SDK compresses every request by default, so the
`transport_compression_level` setting is required.

### Go (`sentry-go`)

```go
import (
    "time"

    "github.com/getsentry/sentry-go"
)

func main() {
    err := sentry.Init(sentry.ClientOptions{
        Dsn:         "https://YOUR_KEY@polaris.example.com/api/telemetry/PROJECT_NUMBER",
        Environment: "production",
        Release:     "my-service@1.4.2",
    })
    if err != nil {
        panic(err)
    }
    defer sentry.Flush(2 * time.Second)

    sentry.ConfigureScope(func(scope *sentry.Scope) {
        scope.SetUser(sentry.User{ID: "42"})
    })
}
```

### Without an SDK

Anything that can post JSON can report to the `store` endpoint:

```bash
curl -X POST "https://polaris.example.com/api/telemetry/api/PROJECT_NUMBER/store/?sentry_key=YOUR_KEY" \
    -H "Content-Type: application/json" \
    -d '{"event_id":"0123456789abcdef0123456789abcdef","level":"error","message":"Test from curl","environment":"staging"}'
```

A stored event answers with its `event_id`.

## Who may report

The public key ships inside every client, so it names a project and proves
nothing. **Reporters** narrows who may use it. Rules are checked in this order:

1. **Address.** One of:
   - **This network, and anything listed** (the default) - private-network
     addresses, plus the addresses and ranges you list. Where an application
     deployed by Polaris reports from.
   - **Only the addresses listed** - for a reporter in a known place (one
     server, one build runner). List at least one.
   - **Anywhere** - required for browser clients.

   Addresses are exact or CIDR ranges. A request with no client address is
   refused under the first two.
2. **Client.** Optional allowed and denied user-agent patterns. A pattern
   matches anywhere in the user agent, ignoring case, with `*` for any run of
   characters (`curl` matches `curl/8.4.0`). A denied pattern always wins; an
   empty allow list means any client; with an allow list, a request without a
   user agent is refused.
3. **Key.** **Also require a key** adds a second value the reporter must send.

Refused reports are counted on the project, with the last address, client and
reason, and an **Allow** button for the address.

### Requiring a key

Turn on **Also require a key** and copy the key shown; it is stored as a digest
and cannot be shown again (turn the setting off and on to make another). A
report must carry it in one of:

- an `X-Polaris-Key: YOUR_SECRET` header,
- `Authorization: Bearer YOUR_SECRET`,
- `sentry_secret=YOUR_SECRET` in the `X-Sentry-Auth` header.

The JavaScript SDKs can add the header through their transport options:

```javascript
Sentry.init({
    dsn: "https://YOUR_KEY@polaris.example.com/api/telemetry/PROJECT_NUMBER",
    transportOptions: { headers: { "X-Polaris-Key": "YOUR_SECRET" } }
});
```

An SDK that cannot set request headers cannot carry the key; narrow it by
address instead. A key in browser code is visible to anyone who loads the page,
so it adds little there.

## Limits

| Limit | Value |
| --- | --- |
| Request size | 1,000,000 bytes |
| Per project | 600 requests per minute |
| Per client address | 300 requests per minute |
| Event retention | 1 to 365 days (30 by default), under **Settings** |

How often each issue happened is kept for a year whatever the retention is.
**Accept reports** under **Settings** turns ingestion off without changing the
DSN: the address keeps answering and nothing is stored.

### Compression

Polaris reads the request body as plain text and does not decode
`Content-Encoding: gzip` or `br`. A compressed request is dropped. Turn
compression off in SDKs that compress (see the Python and Node.js notes).

## Alerts

Under **Alerts**, a project can have up to 50 rules. Each fires on one trigger:

| Trigger | Fires when |
| --- | --- |
| A new issue is created | The first event of a new issue arrives |
| An issue is seen often | More than N events within a window (up to 7 days) |
| A resolved issue comes back | An event reopens a resolved issue |

A rule can be limited to some levels and one environment, notifies the
project's members and up to 20 named people, and fires at most once per
throttle period (1 minute to 7 days, 60 minutes by default). Alerts arrive as
Polaris notifications.

## Troubleshooting

The ingest endpoints never return an error status. Refused, rate-limited,
oversized, unreadable and unknown-project requests all get `200` with
`{"id": ""}`, so a client never retries and the endpoint cannot be used to
find out which projects or keys exist. There are no `401`, `403`, `413` or
`429` answers to look for; a stored event answers with its own id.

| Symptom | Check |
| --- | --- |
| Nothing arrives, project shows refused reports | Read the reason on **Reporters**: the address (browser clients need **Anywhere**), the client rules, or a missing or wrong key. |
| Nothing arrives, nothing refused | The DSN is wrong or the key was replaced; **Accept reports** is off; the body is compressed; the request exceeds 1,000,000 bytes; or the rate limit was hit. |
| Transactions or replays missing | Not supported; only errors and messages are stored. |
| **Users** stays at 0 | Set `user.id` or `user.email`; `{{auto}}` addresses are not counted. |
| All reports from one address behind a proxy | The proxy must pass the client address as the first `X-Forwarded-For` entry or as `X-Real-IP`. |
