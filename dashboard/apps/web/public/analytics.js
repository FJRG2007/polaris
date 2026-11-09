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
 * **It is never allowed to cost the page anything.** It is deferred, so it runs
 * after the document is parsed; the first beat waits for the browser to be idle,
 * so it never competes with the page's own first requests; every request is sent
 * at low priority, so the network puts the page in front of it; and everything it
 * does is inside a try, so a measurement failing is invisible to the visitor
 * rather than an error in their console on somebody else's site. Analytics that
 * slow a page down are analytics that get removed.
 *
 *   <script defer fetchpriority="low" src="https://polaris.example/analytics.js" data-key="..."></script>
 *
 * Optional attributes:
 *   data-host                  - where to send beats, if not the script's own origin
 *   data-auto="false"          - do not track automatically; call polaris.view() yourself
 *   data-domains="a.com,b.com" - only count visits on these hostnames
 *   data-do-not-track="true"   - count nobody whose browser sends Do Not Track
 *   data-exclude-search="true" - drop the query string from every page
 *   data-outbound="true"       - record clicks on links to other sites
 *   data-before-send="fnName"  - a global function that sees every beat first and
 *                                returns it (changed or not), or a falsy value to drop it
 *
 * In the page:
 *   polaris.view(url?)              - count a page by hand
 *   polaris.event(name, props?)     - a custom event; a numeric `revenue` and a
 *                                     `currency` prop are reported as revenue
 *   polaris.identify(id, data?)     - name this visitor in the site's own terms
 *   <button data-polaris-event="signup" data-polaris-event-plan="pro">
 *                                   - an event on click, its props from the attributes
 *
 * Somebody who does not want to be counted on a site (its own team, usually) runs
 * `localStorage.setItem("polaris.disabled", "1")` there; the script only reads it.
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
    const flag = (name) => script.getAttribute(name) === "true";
    const domains = (script.getAttribute("data-domains") || "")
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
    const excludeSearch = flag("data-exclude-search");
    const beforeSendName = script.getAttribute("data-before-send");

    /** Whether this visit is one the site asked not to count. Read each time: a
     *  visitor can opt out without reloading. */
    function silenced() {
        try {
            if (domains.length && !domains.includes(location.hostname.toLowerCase())) return true;
            if (flag("data-do-not-track")) {
                const dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
                if (dnt === "1" || dnt === "yes") return true;
            }
            if (localStorage.getItem("polaris.disabled")) return true;
        } catch {
            /* storage refused: count as usual */
        }
        return false;
    }

    let distinctId = null;

    let lastUrl = null;
    let enteredAt = 0;

    const currentUrl = () => location.pathname + (excludeSearch ? "" : location.search);

    /**
     * Do this when the browser has nothing better to do.
     *
     * The first beat of a visit lands in the same moment as the page's own fonts,
     * images and data, and it is the least urgent thing on the wire. A deadline
     * rather than a wish: a tab that is never idle still reports, a second late.
     */
    function whenIdle(run) {
        try {
            if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 1000 });
            else setTimeout(run, 0);
        } catch {
            run();
        }
    }

    function send(raw, viaBeacon) {
        if (silenced()) return;
        let body = raw;
        if (distinctId && !body.distinctId) body = { ...body, distinctId };
        if (beforeSendName) {
            try {
                const hook = window[beforeSendName];
                if (typeof hook === "function") body = hook(body);
            } catch {
                return;
            }
            if (!body) return;
        }
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
                credentials: "omit",
                // Behind everything the page itself is fetching. Browsers that do
                // not know the option ignore it, which is the same behaviour they
                // had before it was there.
                priority: "low"
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

    function identify(id, data) {
        if (id && typeof id === "object") {
            data = id;
            id = null;
        }
        if (id) distinctId = String(id).slice(0, 100);
        const body = base("identify");
        if (distinctId) body.distinctId = distinctId;
        if (data && typeof data === "object") body.data = data;
        send(body, false);
    }

    window.polaris = { view, event, identify };

    // Events declared in the markup, and links that leave the site. One listener
    // on the document, in the capture phase, so a page that stops propagation on
    // its own buttons still reports them.
    addEventListener(
        "click",
        (clicked) => {
            try {
                const target = clicked.target instanceof Element ? clicked.target : null;
                if (!target) return;
                const tagged = target.closest("[data-polaris-event]");
                if (tagged) {
                    const props = {};
                    for (const attribute of tagged.attributes) {
                        const match = /^data-polaris-event-(.+)$/.exec(attribute.name);
                        if (match) props[match[1]] = attribute.value.slice(0, 240);
                    }
                    event(tagged.getAttribute("data-polaris-event"), Object.keys(props).length ? props : undefined);
                    return;
                }
                if (!flag("data-outbound")) return;
                const link = target.closest("a[href]");
                if (!link || !/^https?:$/.test(link.protocol) || link.host === location.host) return;
                event("outbound-link-click", { url: link.href.slice(0, 240) });
            } catch {
                /* ignore */
            }
        },
        true
    );

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

    // The opening beat, once the browser has drawn what the visitor came for.
    // Everything after it is a route change or a page being closed, which are
    // moments the page is not loading anything anyway.
    whenIdle(() => view());
})();
