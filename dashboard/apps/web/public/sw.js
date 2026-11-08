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

/*
 * Web Push: a notice from Polaris with every tab closed. The payload is what
 * `pushBody` in lib/notifications/web-push.ts writes. A notice with a request id
 * carries Allow / Deny; pressing one answers the agent's permission prompt
 * without opening anything, and a failed answer opens the session instead.
 */
self.addEventListener("push", (event) => {
    let notice = {};
    try {
        notice = event.data ? event.data.json() : {};
    } catch {
        notice = {};
    }
    const title = typeof notice.title === "string" && notice.title ? notice.title : "Polaris";
    const options = {
        body: typeof notice.body === "string" ? notice.body : "",
        icon: "/polaris-mark-192.png",
        badge: "/polaris-mark-192.png",
        tag: typeof notice.tag === "string" ? notice.tag : undefined,
        renotify: typeof notice.tag === "string",
        requireInteraction: notice.requireInteraction === true,
        actions: Array.isArray(notice.actions) ? notice.actions.slice(0, 2) : [],
        data: {
            href: typeof notice.href === "string" && notice.href.startsWith("/") ? notice.href : "/",
            extra: notice.data && typeof notice.data === "object" ? notice.data : {}
        }
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

function openPage(href) {
    const url = new URL(href, self.location.origin).href;
    return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
        for (const client of windows) {
            if (client.url === url && "focus" in client) return client.focus();
        }
        return self.clients.openWindow(url);
    });
}

self.addEventListener("notificationclick", (event) => {
    const data = event.notification.data || {};
    const href = typeof data.href === "string" ? data.href : "/";
    const requestId = data.extra && data.extra.requestId;
    event.notification.close();
    if ((event.action === "allow" || event.action === "deny") && requestId) {
        event.waitUntil(
            fetch("/api/agents/sessions/permission", {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ requestId, choice: event.action })
            })
                .then((answer) => answer.json().then((json) => ({ answer, json })))
                .then(({ answer, json }) => {
                    if (!answer.ok || !json || !json.value || json.value.error) return openPage(href);
                    return undefined;
                })
                .catch(() => openPage(href))
        );
        return;
    }
    event.waitUntil(openPage(href));
});
