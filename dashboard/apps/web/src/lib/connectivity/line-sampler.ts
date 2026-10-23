/**
 * The connectivity sampler: once a minute, how the line is.
 *
 * Each pass connects to a few public addresses by IP (latency, loss), resolves a
 * name through the box's own resolver (so a DNS-only failure shows as one), and
 * every few minutes asks for the public address and whether the dashboard's
 * public name still points at it. The minute is stored, added into its hour, and
 * folded into the line's state (`advanceLine`), whose events become bell
 * notifications and automation events.
 *
 * It does not keep a second outage record: on a down or up it runs the address
 * watcher's pass at once, so `ConnectivityOutage` opens and closes at this pace
 * instead of the watcher's ten minutes. Connect timeouts are also told to the
 * offline breaker (`lib/offline/outbound-lookup`), so the rest of Polaris stops
 * waiting on the line as soon as the sampler has seen it is gone.
 *
 * Runs under a lease (`lib/cron/jobs.ts`), so during an update only one of the
 * two web containers samples. Server-only.
 */

import * as net from "node:net";
import { prisma } from "@polaris/db";
import * as rules from "./line-samples";
import { Resolver } from "node:dns/promises";
import { announceConnectivity } from "./line-events";
import { detectPublicIp } from "@/lib/network-service";
import { getSetting, setSetting } from "@/lib/setting-store";
import { reachableAddresses } from "@/lib/deployment-addresses";
import { noteOutboundFailure } from "@/lib/offline/outbound-lookup";

const STATE_KEY = "connectivity.line";
const CONNECT_TIMEOUT_MS = 2500;
const DNS_TIMEOUT_MS = 3000;
/** How often the public address and the outside check are asked: they go to
 *  outside services, which a minute-by-minute pace would only annoy. */
const ADDRESS_EVERY_MS = 5 * 60_000;

let lastAddressAt = 0;

/** One timed TCP connect. Milliseconds to connect, or null when it did not. */
function connectOnce(host: string, port: number): Promise<number | null> {
    return new Promise((resolve) => {
        const started = performance.now();
        const socket = net.connect({ host, port, timeout: CONNECT_TIMEOUT_MS });
        const done = (value: number | null) => {
            socket.destroy();
            resolve(value);
        };
        socket.once("connect", () => done(Math.round((performance.now() - started) * 10) / 10));
        socket.once("timeout", () => {
            noteOutboundFailure(host, { code: "ETIMEDOUT" });
            done(null);
        });
        socket.once("error", (error) => {
            noteOutboundFailure(host, error);
            done(null);
        });
    });
}

async function probeTargets(): Promise<{ attempts: number; latencies: number[] }> {
    const tries = rules.LINE_TARGETS.flatMap((target) =>
        Array.from({ length: rules.ATTEMPTS_PER_TARGET }, () => target)
    );
    const results = await Promise.all(tries.map((target) => connectOnce(target.host, target.port)));
    return {
        attempts: tries.length,
        latencies: results.filter((value): value is number => value !== null)
    };
}

/** A name through the box's resolver (resolv.conf), not getaddrinfo: the
 *  sampler must not queue on libuv's pool when the line is gone. */
async function probeDns(): Promise<{ ok: boolean; ms: number | null }> {
    const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
    const started = performance.now();
    try {
        const answers = await resolver.resolve4(rules.DNS_PROBE_NAME);
        return {
            ok: answers.length > 0,
            ms: Math.round((performance.now() - started) * 10) / 10
        };
    } catch {
        return { ok: false, ms: null };
    }
}

/** Whether any public name of the dashboard resolves, as the internet sees it,
 *  to the address the box has. Null with nothing to check. */
async function probeOutside(publicIp: string | null): Promise<boolean | null> {
    if (!publicIp) return null;
    const hosts = (await reachableAddresses().catch(() => []))
        .filter((address) => address.kind === "domain")
        .map((address) => address.host.replace(/:\d+$/, ""))
        .slice(0, 5);
    if (hosts.length === 0) return null;
    const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
    resolver.setServers(["1.1.1.1", "8.8.8.8"]);
    const answers = await Promise.all(
        hosts.map((host) => resolver.resolve4(host).catch(() => [] as string[]))
    );
    return answers.some((list) => list.includes(publicIp));
}

/** Measure one sample. Exported for the "Check now" action. */
export async function measureLine(now = Date.now()): Promise<rules.LineProbe> {
    const [targets, dns] = await Promise.all([probeTargets(), probeDns()]);
    let publicIp: string | null = null;
    let outside: boolean | null = null;
    if (targets.latencies.length > 0 && now - lastAddressAt >= ADDRESS_EVERY_MS) {
        lastAddressAt = now;
        publicIp = await detectPublicIp(true).catch(() => null);
        outside = await probeOutside(publicIp).catch(() => null);
    }
    return { ...targets, dnsOk: dns.ok, dnsMs: dns.ms, publicIp, outside };
}

async function store(probe: rules.LineProbe, at: number): Promise<void> {
    const up = probe.latencies.length > 0;
    const latencyMs = rules.median(probe.latencies);
    const lossPct = rules.lossPercent(probe);
    await prisma.connectivitySample.create({
        data: {
            at: new Date(at),
            up,
            dnsOk: probe.dnsOk,
            latencyMs,
            lossPct,
            dnsMs: probe.dnsMs,
            publicIp: probe.publicIp,
            outsideOk: probe.outside
        }
    });
    const sum = rules.sumOfSample({ up, dnsOk: probe.dnsOk, latencyMs, lossPct });
    const bucket = new Date(rules.hourOf(at));
    // One statement, so two writers (there should be one, under the lease) add
    // rather than overwrite each other.
    await prisma.$executeRaw`
        INSERT INTO "ConnectivityHour" ("bucket", "samples", "upSamples", "dnsFailSamples", "latencySum", "latencyCount", "latencyMax", "lossSum")
        VALUES (${bucket}, ${sum.samples}, ${sum.upSamples}, ${sum.dnsFailSamples}, ${sum.latencySum}, ${sum.latencyCount}, ${sum.latencyMax}, ${sum.lossSum})
        ON CONFLICT ("bucket") DO UPDATE SET
            "samples" = "ConnectivityHour"."samples" + EXCLUDED."samples",
            "upSamples" = "ConnectivityHour"."upSamples" + EXCLUDED."upSamples",
            "dnsFailSamples" = "ConnectivityHour"."dnsFailSamples" + EXCLUDED."dnsFailSamples",
            "latencySum" = "ConnectivityHour"."latencySum" + EXCLUDED."latencySum",
            "latencyCount" = "ConnectivityHour"."latencyCount" + EXCLUDED."latencyCount",
            "latencyMax" = GREATEST("ConnectivityHour"."latencyMax", EXCLUDED."latencyMax"),
            "lossSum" = "ConnectivityHour"."lossSum" + EXCLUDED."lossSum"`;
}

async function prune(now: number): Promise<void> {
    await Promise.all([
        prisma.connectivitySample.deleteMany({
            where: { at: { lt: new Date(now - rules.SAMPLE_RETENTION_MS) } }
        }),
        prisma.connectivityHour.deleteMany({
            where: { bucket: { lt: new Date(now - rules.HOUR_RETENTION_MS) } }
        }),
        prisma.publicIpChange.deleteMany({
            where: { at: { lt: new Date(now - rules.HOUR_RETENTION_MS) } }
        })
    ]);
}

/** Wake the address watcher so the outage record moves at the sampler's pace. */
async function wakeOutageRecord(): Promise<void> {
    const { sweepAddresses } = await import("@/lib/address-health");
    await sweepAddresses();
}

/** One pass of the sampler. Answers the events it raised, for the log and the tests. */
export async function sampleConnectivity(now = Date.now()): Promise<rules.ConnectivityEvent[]> {
    const probe = await measureLine(now);
    const before = rules.parseLineState(await getSetting(STATE_KEY));
    const { state, events } = rules.advanceLine(before, probe, now);
    await setSetting(STATE_KEY, JSON.stringify(state));
    await store(probe, now);

    if (probe.publicIp && before.publicIp !== probe.publicIp) {
        // The first address ever seen starts the history; a change continues it.
        const any = before.publicIp ? 1 : await prisma.publicIpChange.count({ take: 1 });
        if (before.publicIp || any === 0) {
            await prisma.publicIpChange.create({
                data: { at: new Date(now), previous: before.publicIp, current: probe.publicIp }
            });
        }
    }
    for (const event of events) await announceConnectivity(event);
    if (events.some((event) => event.event === "down" || event.event === "up")) {
        void wakeOutageRecord().catch((error: unknown) =>
            console.error("polaris: waking the outage record failed:", error)
        );
    }
    await prune(now).catch((error: unknown) =>
        console.error("polaris: pruning connectivity samples failed:", error)
    );
    return events;
}

/** The line's state as the sampler last left it, for the screen and the tools. */
export async function lineState(): Promise<rules.LineState> {
    return rules.parseLineState(await getSetting(STATE_KEY));
}
