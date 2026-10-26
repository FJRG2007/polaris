/**
 * Which of the host's addresses is "the" LAN address, worked out again on every
 * announcement so a new lease, a move to WiFi or a different network is picked up
 * without a restart. Pure: the interface list and the routing table are passed in,
 * so the choice can be asserted without a host.
 */

/** Container plumbing on the host: not internal, and not an address any other
 *  machine on the network can reach - so never the one to advertise. */
const VIRTUAL = /^(docker|br-|veth|virbr|cni|flannel|kube|tailscale|zt)/;

/** Wireless interface names, across the naming schemes in use: wlan0, wlp2s0,
 *  wlx.., and the older ath0 / ra0 of embedded drivers. */
const WIRELESS = /^(wl|wifi|ath\d|ra\d)/;

/**
 * The interfaces that carry a default route, best first, from the text of
 * /proc/net/route. The kernel lists the destination and mask as little-endian hex;
 * a default route is the one whose destination and mask are both zero. Ordered by
 * metric, the way the kernel picks between them.
 */
export function defaultRouteInterfaces(routeTable) {
    const routes = [];
    for (const line of String(routeTable ?? "").split("\n").slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 8) continue;
        const [name, destination, , flags, , , metric, mask] = fields;
        // RTF_UP: a route the kernel would actually use.
        if (destination !== "00000000" || mask !== "00000000") continue;
        if ((Number.parseInt(flags, 16) & 1) === 0) continue;
        routes.push({ name, metric: Number.parseInt(metric, 10) || 0 });
    }
    return routes.sort((a, b) => a.metric - b.metric).map((route) => route.name);
}

/**
 * Every LAN IPv4 the host holds, the one to advertise first.
 *
 * The interface that carries the default route wins: it is the one the router
 * answers on, so it is the network the rest of the house is on. Without a usable
 * route the CABLE wins over WiFi - the wired link is the one that stays up and
 * keeps its lease - and otherwise the order the OS listed them in.
 */
export function lanAddresses(interfaces, routeTable) {
    const preferred = defaultRouteInterfaces(routeTable);
    const found = [];
    for (const [name, addrs] of Object.entries(interfaces ?? {})) {
        if (VIRTUAL.test(name)) continue;
        for (const addr of addrs ?? []) {
            if (addr.family !== "IPv4" && addr.family !== 4) continue;
            if (addr.internal) continue;
            found.push({ name, address: addr.address });
        }
    }
    const rank = (entry) => {
        const routed = preferred.indexOf(entry.name);
        if (routed !== -1) return routed;
        return preferred.length + (WIRELESS.test(entry.name) ? 1 : 0);
    };
    const ordered = found
        .map((entry, index) => ({ ...entry, index }))
        .sort((a, b) => rank(a) - rank(b) || a.index - b.index);
    return [...new Set(ordered.map((entry) => entry.address))];
}
