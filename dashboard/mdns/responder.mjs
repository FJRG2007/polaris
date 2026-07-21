/**
 * mDNS responder for Polaris. Like Home Assistant advertising homeassistant.local,
 * this makes the dashboard reachable at polaris.local from any device on the LAN
 * that speaks multicast DNS (Bonjour on Apple, Avahi on Linux, and Windows 10+).
 *
 * It answers A queries for <name>.local with the host's LAN IPv4 and advertises
 * an _http._tcp service so Polaris shows up in network service discovery. It must
 * run on the host network (multicast does not cross a bridged docker network),
 * which is why the compose service uses network_mode: host.
 */

import { networkInterfaces } from "node:os";
import makeMdns from "multicast-dns";

const NAME = (process.env.POLARIS_MDNS_HOSTNAME || "polaris").toLowerCase();
const FQDN = `${NAME}.local`;
/** Wildcard LAN domain for deployed apps: any `<app>.plr.local` resolves to this
 *  host, so Polaris can hand out clean local hostnames with no per-name DNS setup. */
const APP_DOMAIN_SUFFIX = ".plr.local";
const PORT = Number(process.env.POLARIS_MDNS_PORT || 80);
const SERVICE_TYPE = "_http._tcp.local";
const SERVICE_NAME = `Polaris._http._tcp.local`;
const TTL = 120;

/** The host's primary non-internal IPv4, or an override from the environment. */
function hostIpv4() {
    if (process.env.POLARIS_MDNS_IP) return process.env.POLARIS_MDNS_IP;
    for (const addrs of Object.values(networkInterfaces())) {
        for (const addr of addrs ?? []) {
            if (addr.family === "IPv4" && !addr.internal) return addr.address;
        }
    }
    return "127.0.0.1";
}

const mdns = makeMdns();

/** The records that answer "where is polaris.local" and describe the service. */
function records() {
    const ip = hostIpv4();
    return {
        a: { name: FQDN, type: "A", ttl: TTL, data: ip },
        ptr: { name: SERVICE_TYPE, type: "PTR", ttl: TTL, data: SERVICE_NAME },
        srv: {
            name: SERVICE_NAME,
            type: "SRV",
            ttl: TTL,
            data: { port: PORT, weight: 0, priority: 0, target: FQDN }
        },
        txt: { name: SERVICE_NAME, type: "TXT", ttl: TTL, data: ["path=/"] }
    };
}

/** Push an unsolicited announcement so caches learn the name promptly. */
function announce() {
    const r = records();
    mdns.respond({ answers: [r.a, r.ptr, r.srv, r.txt] });
}

mdns.on("query", (query) => {
    const r = records();
    const answers = [];
    for (const question of query.questions) {
        const name = question.name.toLowerCase();
        if ((question.type === "A" || question.type === "ANY") && name === FQDN) answers.push(r.a);
        // Any <app>.plr.local resolves to this host, so deployed apps get a clean LAN
        // hostname (Traefik then routes each name to its app).
        if ((question.type === "A" || question.type === "ANY") && name.endsWith(APP_DOMAIN_SUFFIX)) {
            answers.push({ name: question.name, type: "A", ttl: TTL, data: r.a.data });
        }
        if (question.type === "PTR" && (name === SERVICE_TYPE || name === "_services._dns-sd._udp.local")) {
            answers.push(r.ptr, r.srv, r.txt, r.a);
        }
        if ((question.type === "SRV" || question.type === "ANY") && name === SERVICE_NAME) {
            answers.push(r.srv, r.a);
        }
    }
    if (answers.length > 0) mdns.respond({ answers });
});

mdns.on("ready", () => {
    process.stdout.write(`polaris-mdns: advertising ${FQDN} -> ${hostIpv4()}:${PORT}\n`);
    announce();
});

const timer = setInterval(announce, 60_000);
timer.unref?.();

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        clearInterval(timer);
        mdns.destroy(() => process.exit(0));
    });
}
