# Analytics: tracker integration

[Leer en español](analytics.es.md) - [Back to the developer guide](README.md)

Polaris Analytics counts visits to your sites without cookies and without
sending anything to a third party. Services deployed on Polaris are counted from
the edge log with no code at all; a small script (`/analytics.js`) adds what a
server log cannot see, and is the only source for sites hosted elsewhere.

In the examples, `https://polaris.example.com` is the public address of your
Polaris and `YOUR_KEY` is the site key.

## Quick start

1. In Polaris, open **Analytics > Websites** and add a site:
   - **Deployed on Polaris** - pick the service. It is already counted from the
     edge log; the tag is optional.
   - **Hosted elsewhere** - give it a name and the domain it is served on. It is
     counted only by the tag.
2. Copy the tag the setup shows for your kind of project. Later, the same tag is
   under the site's **Settings > Tracker**, next to **Accept beats from the
   tracker** and **New key**.
3. Paste it into the `<head>` of every page:

```html
<script defer fetchpriority="low" src="https://polaris.example.com/analytics.js" data-key="YOUR_KEY"></script>
```

4. Open your site in a browser. The setup's **Check the installation** step
   turns green on the first recorded visit.

The tag always points at the address Polaris answers on publicly, since it runs
on somebody else's machine. A LAN-only address loads nothing outside your
network.

## What is counted, with and without the script

| | Edge log (no script) | Tracker |
| --- | --- | --- |
| Available for | Services deployed on Polaris | Any site |
| Pageviews, referrers, UTM campaign | Yes | Yes |
| Browser, OS, device | Yes (from the user agent) | Yes |
| Language | No | Yes |
| Country | Yes | Yes |
| Visit duration | No | Yes |
| Screen size, time zone | No | Yes |
| Single-page route changes | No | Yes |
| Custom events, revenue, identify | No | Yes |

The edge log skips static assets (`.css`, `.js`, images, fonts, `.json`, `.xml`
and similar) and machinery paths (`/_next/`, `/__nextjs`, `/api/`,
`/.well-known/`, `/cdn-cgi/`). It is controlled per instance by **Count visits
from the edge log** in the collection settings.

Both sources go through the same recording path, so they never count
differently. Recognised bots are not recorded unless **Count recognized bots as
visitors** is on.

## Script tag options

All options are attributes on the `<script>` tag.

| Attribute | Effect |
| --- | --- |
| `data-key="YOUR_KEY"` | Required. The site key. Without it the script does nothing. |
| `data-host="https://..."` | Send beats here instead of the script's own origin. |
| `data-auto="false"` | No automatic tracking: no first view, no route changes, no visit duration. Call `polaris.view()` yourself. Click events still work. |
| `data-domains="example.com,www.example.com"` | Only count visits whose hostname is exactly one of these (case-insensitive, no wildcards). |
| `data-do-not-track="true"` | Skip browsers that send Do Not Track. |
| `data-exclude-search="true"` | Drop the query string from every page. UTM parameters are then not read either. |
| `data-outbound="true"` | Record clicks on links to other hosts as `outbound-link-click`, with the link in `url`. |
| `data-before-send="beforeSend"` | Name of a global function that sees each beat first. |

### `data-before-send`

The function is looked up on `window` at every send, so it can be defined after
the script tag. It receives the beat and returns it (changed or not), or a falsy
value to drop it. If it throws, the beat is dropped.

```html
<script>
    function beforeSend(beat) {
        if (beat.url.startsWith("/admin")) return null;
        beat.url = beat.url.replace(/\/users\/\d+/, "/users/:id");
        return beat;
    }
</script>
<script defer fetchpriority="low" src="https://polaris.example.com/analytics.js" data-key="YOUR_KEY" data-before-send="beforeSend"></script>
```

A beat has `key`, `type` (`view`, `event`, `leave` or `identify`), `url` (path
and query), `screen`, `language`, `timezone`, and depending on the type
`referrer`, `title`, `name`, `props`, `distinctId`, `data` and `durationMs`. A
beat that no longer matches the [limits](#limits-and-validation) is discarded by
the server.

## Single-page apps

With automatic tracking on, the script wraps `history.pushState` and
`history.replaceState` and listens to `popstate`, so React Router, Vue Router,
the Next.js router and any other History API router are counted with no extra
code. A change that keeps the same URL is not counted twice.

The previous page is closed with its duration when the route changes, the tab
is hidden, or the page is left (`pagehide`, sent with `sendBeacon`). Views under
one second get no duration.

To count pages by hand, turn automatic tracking off and call `polaris.view()`:

```js
polaris.view();              // the current path and query
polaris.view("/checkout/2"); // a path of your choice
```

## Custom events

```js
polaris.event("signup", { plan: "pro", seats: 3, trial: true });
```

- Name: 1 to 120 characters (longer names are cut to 120 by the script).
- Properties: a flat object of up to 20 keys. Keys are 1 to 60 characters;
  values are strings up to 240 characters, finite numbers or booleans. Nested
  objects and arrays are not accepted.
- A beat that breaks these rules is dropped whole, not trimmed.

`polaris` exists once the script has run. With `defer`, guard calls made early:

```js
window.polaris?.event("signup");
```

### Events from markup

Any element with `data-polaris-event` sends an event when it, or anything
inside it, is clicked. Each `data-polaris-event-<name>` attribute becomes a
property (string, up to 240 characters):

```html
<button data-polaris-event="signup" data-polaris-event-plan="pro">Start</button>
```

The listener runs in the capture phase, so handlers that stop propagation do not
hide the click.

### Revenue

An event with a numeric `revenue` property is reported as revenue, grouped by
its `currency` property (upper-cased). Amounts are summed per currency, never
converted, so always send the same currency code for the same money.

```js
polaris.event("purchase", { revenue: 19.9, currency: "EUR" });
```

## Identify a visitor

```js
polaris.identify("user-42", { plan: "pro" });
polaris.identify({ plan: "pro" }); // data only, no id
```

- The id (up to 100 characters) is your own name for the visitor. It is kept in
  memory and sent with every later beat on that page load, so call `identify`
  on each page load once you know who is signed in.
- `data` follows the same rules as event properties and is stored on the visit.
- Identify starts no visit of its own. If it arrives before the first view has
  been recorded, its `data` is lost; the id still travels with the next beats.
- The id is what recognises a returning visitor past the daily session reset,
  and what the **Retention** report counts.

Only send ids you are allowed to process. Prefer an opaque id to an email.

## Opting yourself out

In a browser where your own visits should not count, run this in the console on
your site:

```js
localStorage.setItem("polaris.disabled", "1");
```

`localStorage.removeItem("polaris.disabled")` undoes it. The script only reads
this key; it never writes to the visitor's machine. To ignore a whole office or
your team's addresses, use **Ignored traffic** instead.

## Frameworks

Every variant loads the same script with the same key. The setup screen writes
each one for you.

### Plain HTML, React (Vite) and Vue

Paste the tag into the `<head>` of `index.html` (or every page for a static
site):

```html
<script defer fetchpriority="low" src="https://polaris.example.com/analytics.js" data-key="YOUR_KEY"></script>
```

### Next.js

Add it once to the root layout (`app/layout.tsx`), inside `<body>`:

```jsx
import Script from "next/script";

<Script src="https://polaris.example.com/analytics.js" data-key="YOUR_KEY" strategy="afterInteractive" />
```

### Astro

In the layout every page uses (`src/layouts/Layout.astro`), inside `<head>`:

```html
<script is:inline defer fetchpriority="low" src="https://polaris.example.com/analytics.js" data-key="YOUR_KEY"></script>
```

### WordPress and other server-rendered sites

Print the tag into the head. For WordPress, in your theme's `functions.php` or a
code snippets plugin:

```php
add_action("wp_head", function () {
    echo '<script defer fetchpriority="low" src="https://polaris.example.com/analytics.js" data-key="YOUR_KEY"></script>';
});
```

### Google Tag Manager

**Tags > New > Custom HTML**, triggered on **All Pages**:

```html
<script>
    (function () {
        var s = document.createElement("script");
        s.defer = true;
        s.src = "https://polaris.example.com/analytics.js";
        s.setAttribute("data-key", "YOUR_KEY");
        document.head.appendChild(s);
    })();
</script>
```

## Content-Security-Policy

If your site sends a CSP, allow the script and the endpoint it posts to:

```text
script-src 'self' https://polaris.example.com;
connect-src 'self' https://polaris.example.com;
```

With `data-host`, put that origin in `connect-src` instead. Beats are sent with
`fetch` (or `navigator.sendBeacon` when a page closes) to
`/api/analytics/collect`, with no credentials.

## Privacy

- **No cookies, no storage.** Nothing is written to the visitor's machine, so
  there is no consent banner to show for it.
- **Sessions are a daily hash.** A visit's id is a SHA-256 hash of a salt, the
  site, the address and the user agent. The salt is random and replaced every
  day, so a visitor cannot be followed from one day to the next unless the site
  calls `identify`. A visit ends after 30 minutes without a beat.
- **Country stays on your server.** It is read from the `CF-IPCountry` header
  when a proxy sets one, else from a local copy of DB-IP's "IP to Country Lite"
  database (downloaded by Polaris and refreshed monthly; no visitor address is
  ever sent out to be looked up), else from the browser's time zone.
- **Nothing goes to third parties.** The script and the endpoint are both your
  Polaris.
- **Retention.** The address, individual visits and their pages are kept for
  **Keep per-visit detail for** days (180 by default, 1 to 3650), then deleted.
  The daily totals behind the charts are kept.

## Ignored traffic, export and reset

Per site, under **Settings**:

- **Ignored traffic** - up to 50 pages and 50 addresses whose visits are never
  recorded, from the edge log and the tracker alike. A page starts with `/` and
  matches exactly, or as a prefix when it ends in `*` (`/admin*`). An address is
  exact, or an IPv4 range in CIDR form (`203.0.113.0/24`).
- **Export CSV** - every page and event in the selected range and filters, with
  its visit: `at, visit, kind, event, path, url, properties, visitor, browser,
  os, device, country, language, screen, channel, referrer, campaign, medium`.
  Up to 500,000 rows per export. It needs a signed-in account with access to the
  site; it is not a public API.
- **Delete data** - removes every recorded visit, event and daily total.
  Settings and saved reports stay.

## Limits and validation

The endpoint (`POST /api/analytics/collect`) accepts one JSON beat per request
and checks it against a fixed schema:

| Field | Rule |
| --- | --- |
| `key` | 8 to 64 characters |
| `type` | `view`, `event`, `leave` or `identify` |
| `url` | up to 2048 characters |
| `referrer` | up to 2048 characters |
| `title` | up to 120 characters |
| `name` | 1 to 120 characters |
| `props`, `data` | flat, up to 20 keys of 1 to 60 characters; string (up to 240), finite number or boolean values |
| `distinctId` | 1 to 100 characters |
| `screen` | `WIDTHxHEIGHT`, 2 to 5 digits each |
| `language` | up to 35 characters |
| `timezone` | up to 64 characters |
| `durationMs` | integer, 0 to 86,400,000 (one day) |

- 120 beats per minute per client address. Beats past it are dropped.
- The page's origin is read from the request's `Origin` or `Referer` header,
  not from the payload.
- The answer is always an empty `204`, whatever happened: an invalid beat, an
  unknown key, a key whose tracker is off and an accepted beat look the same.
  A `204` in the network tab proves only that the request reached Polaris.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No visits at all | **Accept beats from the tracker** must be on for the site. While it is off the endpoint ignores the key. |
| Stopped after **New key** | The old key stops working. Paste the new tag everywhere. |
| Nothing on some domains | `data-domains` must list every hostname exactly, including `www.` variants. |
| Nothing from your own browser | `polaris.disabled` is set in that browser, Do Not Track is on with `data-do-not-track`, or your address is in **Ignored traffic**. |
| A page never appears | It matches an excluded page, or `data-before-send` returns nothing for it. |
| Script blocked in the console | Add the CSP entries above. Content blockers may also block a file named `analytics.js`; those visitors are only counted from the edge log, and only for services deployed on Polaris. |
| Events missing | The beat broke a [limit](#limits-and-validation) (nested props, over 20 keys, a value over 240 characters) and was dropped. |
| Durations missing | `data-auto="false"` sends no leave beats; durations need automatic tracking. |
| Few or no visitors behind a proxy | A proxy in front of Polaris must pass the visitor's address as the first `X-Forwarded-For` entry or as `X-Real-IP`. Without either a beat is dropped; with the proxy's own address every visitor shares one session and one rate limit. |
