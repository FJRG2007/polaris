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
