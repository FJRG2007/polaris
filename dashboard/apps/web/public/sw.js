/*
 * Polaris' service worker, and deliberately a small one.
 *
 * It exists for the installed app: when Polaris cannot be reached - the machine is
 * off, the laptop is on another network - a window that opens onto a browser
 * error page reads as a broken app. So a page load that fails is answered with a
 * short page saying Polaris is not reachable, and nothing else is touched.
 *
 * Nothing is cached but that page. Every request, page loads included, goes to
 * the network as it always has: a stored copy of a screen or a redirect is how a
 * tab shows yesterday's state, and the login handoff in particular must never be
 * replayed.
 */

const CACHE = "polaris-offline-v1";
const OFFLINE = "/offline.html";

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
            .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    if (event.request.mode !== "navigate") return;
    event.respondWith(
        fetch(event.request).catch(() =>
            caches.match(OFFLINE).then((page) => page || new Response("Polaris is not reachable.", { status: 503 }))
        )
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

    const pressed = (Array.isArray(data.actions) ? data.actions : []).find((one) => one && one.id === event.action);
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

    const href = typeof data.href === "string" && data.href.startsWith("/") && !data.href.startsWith("//") ? data.href : null;
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
