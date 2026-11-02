/*
 * Polaris' service worker, and deliberately a small one.
 *
 * It exists for the installed app: when Polaris cannot be reached - the machine is
 * off, the laptop is on another network - a window that opens onto a browser
 * error page reads as a broken app. So a page load that fails, or that a gateway
 * or tunnel answers on behalf of a Polaris it cannot reach, is answered with a
 * short page saying Polaris is not reachable, and nothing else is touched.
 *
 * Nothing is cached but that page. Every request, page loads included, goes to
 * the network as it always has: a stored copy of a screen or a redirect is how a
 * tab shows yesterday's state, and the login handoff in particular must never be
 * replayed.
 */

const CACHE = "polaris-offline-v3";
const OFFLINE = "/offline.html";

/* The same statuses as `isGatewayFailure` in `@polaris/core/instance-fallback`. */
function isGatewayFailure(status) {
    return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
}

function offlinePage(answer) {
    return caches
        .match(OFFLINE)
        .then(
            (page) => page || answer || new Response("Polaris is not reachable.", { status: 503 })
        );
}

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches
            .open(CACHE)
            .then((cache) => cache.add(new Request(OFFLINE, { cache: "reload" })))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((names) =>
                Promise.all(
                    names.filter((name) => name !== CACHE).map((name) => caches.delete(name))
                )
            )
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    if (event.request.mode !== "navigate") return;
    event.respondWith(
        fetch(event.request)
            .then((answer) => (isGatewayFailure(answer.status) ? offlinePage(answer) : answer))
            .catch(() => offlinePage())
    );
});

/*
 * A notice drawn through here - one with buttons, like a message's "Mark as
 * read". A press on a button makes the request the page put on it, which works
 * with no Polaris tab open at all; a press on the notice brings a Polaris window
 * forward on the page it names, or opens one.
 */
self.addEventListener("notificationclick", (event) => {
    const notice = event.notification;
    const data = notice.data || {};
    notice.close();

    const pressed = (Array.isArray(data.actions) ? data.actions : []).find(
        (one) => one && one.id === event.action
    );
    if (pressed) {
        const request = pressed.request || {};
        // Only a request back to this Polaris's own API.
        if (typeof request.url !== "string" || !request.url.startsWith("/api/")) return;
        event.waitUntil(
            fetch(request.url, {
                method: "POST",
                credentials: "same-origin",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(request.body ?? null)
            }).catch(() => undefined)
        );
        return;
    }

    const href =
        typeof data.href === "string" && data.href.startsWith("/") && !data.href.startsWith("//")
            ? data.href
            : null;
    event.waitUntil(
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
            const target = windows.find((one) => one.focused) || windows[0];
            if (!target) return self.clients.openWindow(href || "/");
            return target.focus().then((focused) => {
                if (href) (focused || target).postMessage({ kind: "polaris-notice-open", href });
            });
        })
    );
});
