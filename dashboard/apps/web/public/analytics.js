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
 *   data-outbound="true"       - record clicks on links to other sites, and on mailto:/tel: links
 *   data-downloads="true"      - record clicks on file links (or a comma list of extensions)
 *   data-forms="true"          - record form submissions
 *   data-hash="true"           - count the #hash as part of the page, for hash routers
 *   data-404="true"            - this is an error page: record a 404 event for it
 *   data-vitals="true"         - measure Core Web Vitals (LCP, INP, CLS, FCP, TTFB) and send
 *                                them once per page load, when the first page is left
 *   data-before-send="fnName"  - a global function that sees every beat first and
 *                                returns it (changed or not), or a falsy value to drop it
 *   data-prop-<name>="value"   - a property sent with every page view of this tag
 *
 * Outbound links, downloads, forms, hash routing and vitals can also be switched on
 * for the site in Polaris instead of on the tag: the script asks for them once
 * the page is idle (the browser keeps the answer for five minutes). An attribute
 * on the tag, "true" or "false", always wins over the site's setting.
 *
 * In the page:
 *   polaris.view(url?, props?)      - count a page by hand
 *   polaris.event(name, props?)     - a custom event; a numeric `revenue` and a
 *                                     `currency` prop are reported as revenue
 *   polaris.identify(id, data?)     - name this visitor in the site's own terms
 *   <button data-polaris-event="signup" data-polaris-event-plan="pro">
 *                                   - an event on click, its props from the attributes
 *
 * Somebody who does not want to be counted on a site (its own team, usually) runs
 * `localStorage.setItem("polaris.disabled", "1")` there, or opens any page of the
 * site with `?polaris-ignore=on` (`=off` counts that browser again). That link is
 * the only time the script writes to the visitor's storage, and only because the
 * visitor asked it to.
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
    /** The site's own options, filled in when Polaris answers; empty until then. */
    const remote = {};
    const flag = (name) => (script.hasAttribute(name) ? script.getAttribute(name) === "true" : remote[name] === true);
    const domains = (script.getAttribute("data-domains") || "")
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
    const excludeSearch = flag("data-exclude-search");
    // The extensions a link to a file usually ends in; a site can name its own.
    function downloadList() {
        const named = script.hasAttribute("data-downloads") ? script.getAttribute("data-downloads") : remote["data-downloads"];
        if (!named || named === "false") return [];
        return (
            named === "true" || named === true
                ? "pdf,xlsx,docx,txt,rtf,csv,exe,key,pps,ppt,pptx,7z,pkg,rar,gz,zip,avi,mov,mp4,mpeg,wmv,midi,mp3,wav,wma,dmg"
                : String(named)
        )
            .split(",")
            .map((entry) => entry.trim().toLowerCase().replace(/^\./, ""))
            .filter(Boolean);
    }
    // Properties the tag sends with every page view: data-prop-author="Jane".
    const tagProps = {};
    for (const attribute of script.attributes) {
        const match = /^data-prop-(.+)$/.exec(attribute.name);
        if (match) tagProps[match[1].slice(0, 60)] = attribute.value.slice(0, 240);
    }
    const beforeSendName = script.getAttribute("data-before-send");

    // The opt-out link: ?polaris-ignore=on stops counting this browser, =off undoes it.
    try {
        const ignore = new URLSearchParams(location.search).get("polaris-ignore");
        if (ignore === "on") localStorage.setItem("polaris.disabled", "1");
        else if (ignore === "off") localStorage.removeItem("polaris.disabled");
    } catch {
        /* storage refused: nothing to remember it in */
    }

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

    const currentUrl = () =>
        location.pathname + (excludeSearch ? "" : location.search) + (flag("data-hash") ? location.hash : "");

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

    // Core Web Vitals, read from the browser's own performance entries. One set per
    // document: the metrics describe the page that was loaded, so they are sent the
    // first time it is left (a route change, the tab hidden, the page closed).
    let vitalsOn = false;
    const vitals = {};
    let vitalsSent = false;
    function observe(type, take, extra) {
        try {
            new PerformanceObserver((list) => list.getEntries().forEach(take)).observe({ type, buffered: true, ...extra });
        } catch {
            /* not supported here: that metric is simply not sent */
        }
    }
    /** Start measuring once the tag or the site asks for vitals; harmless twice. */
    function startVitals() {
        if (vitalsOn || !flag("data-vitals")) return;
        vitalsOn = true;
        addEventListener("pagehide", () => sendVitals(lastUrl));
        addEventListener("visibilitychange", () => document.visibilityState === "hidden" && sendVitals(lastUrl));
        observe("largest-contentful-paint", (entry) => (vitals.lcp = entry.startTime));
        observe("paint", (entry) => entry.name === "first-contentful-paint" && (vitals.fcp = entry.startTime));
        // CLS is the worst burst of shifts: a window closes after a second of calm
        // or five seconds in all. Shifts right after input are expected, not counted.
        let burst = 0;
        let first = 0;
        let last = 0;
        observe("layout-shift", (entry) => {
            if (entry.hadRecentInput) return;
            if (burst && entry.startTime - last < 1000 && entry.startTime - first < 5000) burst += entry.value;
            else {
                burst = entry.value;
                first = entry.startTime;
            }
            last = entry.startTime;
            vitals.cls = Math.max(vitals.cls || 0, burst);
        });
        // The slowest interaction stands in for INP: on a single page load it is the
        // same figure for all but the rare page with fifty or more interactions.
        observe("event", (entry) => entry.interactionId && (vitals.inp = Math.max(vitals.inp || 0, entry.duration)), {
            durationThreshold: 40
        });
        try {
            const navigation = performance.getEntriesByType("navigation")[0];
            if (navigation && navigation.responseStart > 0) vitals.ttfb = navigation.responseStart;
        } catch {
            /* ignore */
        }
    }

    function sendVitals(url) {
        if (!vitalsOn || vitalsSent) return;
        const measured = {};
        for (const metric of ["lcp", "inp", "cls", "fcp", "ttfb"]) {
            const value = vitals[metric];
            if (typeof value !== "number" || !isFinite(value) || value < 0) continue;
            measured[metric] = metric === "cls" ? Math.min(100, Math.round(value * 10000) / 10000) : Math.min(60000, Math.round(value));
        }
        if (!Object.keys(measured).length) return;
        vitalsSent = true;
        send({ ...base("vitals"), url: url || currentUrl(), vitals: measured }, true);
    }

    // The deepest point of the page seen so far, in percent of its height. Only a
    // number leaves the page: never what was on it.
    let scrolled = 0;
    function measureScroll() {
        try {
            const doc = document.documentElement;
            const height = Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0);
            if (!height) return;
            const seen = ((window.scrollY || doc.scrollTop || 0) + window.innerHeight) / height;
            scrolled = Math.max(scrolled, Math.min(100, seen * 100));
        } catch {
            /* ignore */
        }
    }
    let scrollQueued = false;
    addEventListener(
        "scroll",
        () => {
            if (scrollQueued) return;
            scrollQueued = true;
            requestAnimationFrame(() => {
                scrollQueued = false;
                measureScroll();
            });
        },
        { passive: true }
    );

    /** Close the page being left, so the visit has a measured length. */
    function leave() {
        // Not before the first page is even recorded: the opening view also calls this.
        if (lastUrl) sendVitals(lastUrl);
        if (!enteredAt) return;
        const elapsed = Date.now() - enteredAt;
        enteredAt = 0;
        if (elapsed < 1000) return;
        // The page being left, not the one a client-side navigation already shows.
        send({ ...base("leave"), url: lastUrl || currentUrl(), durationMs: elapsed, scroll: Math.round(scrolled) }, true);
    }

    function view(url, props) {
        const next = url || currentUrl();
        // A framework that replaces the same URL should not count twice; a real
        // navigation always changes it.
        if (next === lastUrl) return;
        leave();
        lastUrl = next;
        enteredAt = Date.now();
        scrolled = 0;
        measureScroll();
        const body = { ...base("view"), url: next };
        // Only the first view of a visit has a referrer worth reading - after that it
        // is this site linking to itself, which the server files as a self referral
        // and discards anyway.
        if (document.referrer) body.referrer = document.referrer;
        if (document.title) body.title = document.title.slice(0, 120);
        const extra = { ...tagProps, ...(props && typeof props === "object" ? props : {}) };
        if (Object.keys(extra).length) body.props = extra;
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
                const link = target.closest("a[href]");
                if (!link) return;
                const url = link.href.slice(0, 240);
                const downloads = downloadList();
                if (downloads.length && /^https?:$/.test(link.protocol)) {
                    const extension = /\.([a-z0-9]+)$/i.exec(link.pathname);
                    if (link.hasAttribute("download") || (extension && downloads.includes(extension[1].toLowerCase()))) {
                        event("file-download", { url });
                        return;
                    }
                }
                if (!flag("data-outbound")) return;
                // The scheme and address only: a prefilled subject or body is the
                // page's text, not where the click went.
                if (/^(mailto|tel):$/.test(link.protocol)) {
                    event("contact-link-click", { url: url.split("?")[0] });
                    return;
                }
                if (!/^https?:$/.test(link.protocol) || link.host === location.host) return;
                event("outbound-link-click", { url });
            } catch {
                /* ignore */
            }
        },
        true
    );

    // A form sent, whatever framework handles it. Capture phase, like the clicks,
    // and before the page's own handler can navigate away.
    addEventListener(
        "submit",
        (submitted) => {
            try {
                if (!flag("data-forms")) return;
                const form = submitted.target instanceof HTMLFormElement ? submitted.target : null;
                if (!form || form.hasAttribute("data-polaris-event")) return;
                const props = { path: new URL(form.action || location.href, location.href).pathname.slice(0, 240) };
                if (form.id) props.id = form.id.slice(0, 240);
                event("form-submit", props);
            } catch {
                /* ignore */
            }
        },
        true
    );

    // An error page says so on its own tag, and every view of it is a 404 for the
    // address that was asked for.
    if (flag("data-404")) whenIdle(() => event("404", { path: currentUrl().slice(0, 240) }));

    startVitals();

    // The options set for the site in Polaris. Only switches are taken from the
    // answer; anything else in it is ignored.
    whenIdle(() => {
        try {
            fetch(`${endpoint}?key=${encodeURIComponent(key)}`, { mode: "cors", credentials: "omit", priority: "low" })
                .then((answer) => (answer && answer.ok ? answer.json() : null))
                .then((options) => {
                    if (!options || typeof options !== "object") return;
                    for (const name of ["data-outbound", "data-forms", "data-hash", "data-vitals", "data-downloads"])
                        if (options[name] === true) remote[name] = true;
                    startVitals();
                })
                .catch(() => {
                    /* the tag's own attributes are all there is */
                });
        } catch {
            /* ignore */
        }
    });

    if (!auto) return;

    addEventListener("hashchange", () => flag("data-hash") && view());

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
