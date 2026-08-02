/**
 * The Polaris visit tracker.
 *
 * Everything a server-side access log cannot see: how long a page was read, the
 * screen it was read on, the visitor's time zone, single-page route changes, and
 * custom events. Pageview counts come from the edge log with no script at all, so
 * this is an addition rather than the thing that makes analytics work.
 *
 * No cookies, no local storage, nothing written to the visitor's machine. The
 * session is a hash the server computes from a salt it rotates daily, so there is
 * nothing here to consent to and nothing that can follow anyone to tomorrow.
 *
 * Deliberately one small file with no build step: it is served to somebody else's
 * page, and the honest size of it is part of the deal.
 *
 *   <script defer src="https://polaris.example/analytics.js" data-key="..."></script>
 *
 * Optional attributes:
 *   data-host         - where to send beats, if not the script's own origin
 *   data-auto="false" - do not track automatically; call polaris.view() yourself
 */
(() => {
    "use strict";

    const script = document.currentScript;
    if (!script) return;

    const key = script.getAttribute("data-key");
    if (!key) return;

    const host = (script.getAttribute("data-host") || new URL(script.src).origin).replace(/\/$/, "");
    const endpoint = `${host}/api/analytics/collect`;
    const auto = script.getAttribute("data-auto") !== "false";

    let lastUrl = null;
    let enteredAt = 0;

    const currentUrl = () => location.pathname + location.search;

    function send(body, viaBeacon) {
        const payload = JSON.stringify(body);
        // A page being closed is exactly when the most interesting beat is sent, and
        // that is the one moment a normal fetch is allowed to be cancelled. sendBeacon
        // is the only thing that survives it.
        if (viaBeacon && navigator.sendBeacon) {
            try {
                navigator.sendBeacon(endpoint, new Blob([payload], { type: "application/json" }));
                return;
            } catch {
                // Fall through to fetch.
            }
        }
        try {
            fetch(endpoint, {
                method: "POST",
                body: payload,
                headers: { "Content-Type": "application/json" },
                keepalive: true,
                mode: "cors",
                credentials: "omit"
            }).catch(() => {
                // Analytics must never surface as an error on somebody's site.
            });
        } catch {
            /* ignore */
        }
    }

    const base = (type) => ({
        key,
        type,
        url: currentUrl(),
        screen: `${screen.width}x${screen.height}`,
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    });

    /** Close the page being left, so the visit has a measured length. */
    function leave() {
        if (!enteredAt) return;
        const elapsed = Date.now() - enteredAt;
        enteredAt = 0;
        if (elapsed < 1000) return;
        send({ ...base("leave"), durationMs: elapsed }, true);
    }

    function view(url) {
        const next = url || currentUrl();
        // A framework that replaces the same URL should not count twice; a real
        // navigation always changes it.
        if (next === lastUrl) return;
        leave();
        lastUrl = next;
        enteredAt = Date.now();
        const body = { ...base("view"), url: next };
        // Only the first view of a visit has a referrer worth reading - after that it
        // is this site linking to itself, which the server files as a self referral
        // and discards anyway.
        if (document.referrer) body.referrer = document.referrer;
        if (document.title) body.title = document.title.slice(0, 120);
        send(body, false);
    }

    function event(name, props) {
        if (!name) return;
        const body = { ...base("event"), name: String(name).slice(0, 120) };
        if (props && typeof props === "object") body.props = props;
        send(body, false);
    }

    window.polaris = { view, event };

    if (!auto) return;

    // Single-page navigation. history.pushState fires no event of its own, so the two
    // methods are wrapped - the one reliable way to see a route change without polling
    // and without depending on which router the page uses.
    for (const method of ["pushState", "replaceState"]) {
        const original = history[method];
        if (typeof original !== "function") continue;
        history[method] = function patched(...args) {
            const result = original.apply(this, args);
            // On the next tick, so the URL and the title are the new page's.
            setTimeout(() => view(), 0);
            return result;
        };
    }
    addEventListener("popstate", () => view());

    // pagehide rather than unload: unload is ignored on mobile Safari and blocks the
    // back-forward cache everywhere else.
    addEventListener("pagehide", leave);
    addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") leave();
        else if (!enteredAt) enteredAt = Date.now();
    });

    view();
})();
