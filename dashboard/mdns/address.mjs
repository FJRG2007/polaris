/**
 * Which of the host's addresses is "the" LAN address, worked out again on every
 * announcement so a new lease, a move to WiFi or a different network is picked up
 * without a restart. Pure: the interface list and the routing table are passed in,
 * so the choice can be asserted without a host.
 */

/** Container and VM plumbing and VPN tunnels on the host: not internal, and not
 *  an address the other machines on this network reach the server by - so never
 *  the one to advertise. The call server's start script skips the same names. */
const VIRTUAL =
    /^(docker|br-|veth|virbr|cni|flannel|kube|tailscale|zt|wg|tun|tap|podman|lxcbr|lxdbr|vboxnet|vmnet)/;

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
    for (const line of String(routeTable ?? "")
        .split("\n")
        .slice(1)) {
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
            // Self-assigned when no lease came: nobody else on the network has it.
            if (String(addr.address).startsWith("169.254.")) continue;
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

/** Kernel address flags, as /proc/net/if_inet6 prints them (`ifa_flags`, low byte). */
const IFA_F_TEMPORARY = 0x01;
const IFA_F_DADFAILED = 0x08;
const IFA_F_DEPRECATED = 0x20;
const IFA_F_TENTATIVE = 0x40;
const UNUSABLE = IFA_F_TEMPORARY | IFA_F_DADFAILED | IFA_F_DEPRECATED | IFA_F_TENTATIVE;

/** 32 hex digits, as procfs prints an IPv6 address, to the usual colon form. */
function hexToIpv6(hex) {
    const groups = [];
    for (let index = 0; index < 32; index += 4)
        groups.push(Number.parseInt(hex.slice(index, index + 4), 16).toString(16));
    return groups.join(":");
}

/**
 * The interfaces that carry an IPv6 default route, best first, from the text of
 * /proc/net/ipv6_route. A default route has an all-zero destination and prefix
 * length 0; the kernel parks unreachable defaults on `lo`, which are not routes
 * anybody leaves by.
 */
export function defaultRouteInterfaces6(routeTable) {
    const routes = [];
    for (const line of String(routeTable ?? "").split("\n")) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 10) continue;
        const [destination, prefix, , , , metric, , , flags, name] = fields;
        if (!/^0{32}$/.test(destination) || prefix !== "00" || name === "lo") continue;
        if ((Number.parseInt(flags, 16) & 1) === 0) continue;
        routes.push({ name, metric: Number.parseInt(metric, 16) || 0 });
    }
    return [...new Set(routes.sort((a, b) => a.metric - b.metric).map((route) => route.name))];
}

/**
 * The host's stable global IPv6 on the interface that carries the IPv6 default
 * route, or null.
 *
 * Read from /proc/net/if_inet6 rather than os.networkInterfaces() because only
 * the kernel's table carries the flags: a temporary (privacy) address rotates
 * every few hours and would make a DNS record that points at it go stale, and a
 * deprecated or still-tentative one is on its way out or not yet usable. Only
 * 2000::/3 counts - unique-local (fc00::/7) and link-local addresses reach no
 * visitor. Without a default IPv6 route nothing outside can answer back, so
 * nothing is returned.
 */
export function globalIpv6(addressTable, routeTable) {
    const routed = defaultRouteInterfaces6(routeTable);
    if (routed.length === 0) return null;
    const found = [];
    for (const line of String(addressTable ?? "").split("\n")) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 6) continue;
        const [hex, , , scope, flags, name] = fields;
        if (!/^[0-9a-f]{32}$/i.test(hex) || VIRTUAL.test(name)) continue;
        // Scope 00 is global; link-local is 20, host 10.
        if (scope !== "00") continue;
        if ((Number.parseInt(flags, 16) & UNUSABLE) !== 0) continue;
        const first = Number.parseInt(hex.slice(0, 4), 16);
        if (first < 0x2000 || first > 0x3fff) continue;
        const rank = routed.indexOf(name);
        if (rank === -1) continue;
        found.push({ rank, address: hexToIpv6(hex.toLowerCase()) });
    }
    found.sort((a, b) => a.rank - b.rank);
    return found[0]?.address ?? null;
}
