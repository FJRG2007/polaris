/** Network filter: the DNS server for the whole network, blocking ads and trackers. */

import { PageHeader } from "@polaris/ui";
import { Chrome } from "../runtime/chrome";
import { toWire } from "@/lib/app-bundles/wire";
import * as dns from "@/lib/dns-blocker/settings";
import { routerBrandsFor } from "@/lib/router-guide";
import { defineScene, type SceneContext } from "../runtime/scene";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { routerGuideIn } from "@/app/(app)/admin/domains/router-words";
import { DnsOverviewSection } from "@/app/(app)/apps/network-filter/overview-section";
import { DnsBlockerProvider } from "@/app/(app)/apps/network-filter/dns-blocker-context";

/** A documentation address range (RFC 5737) stands in for the LAN. */
const ADDRESS = "192.0.2.10";
const BUCKET = 600_000;
const BUCKETS = 36;
/** The upstream resolver, as the engine names it, on a documentation address. */
const UPSTREAM = "tcp+udp:198.51.100.53";

const CLIENTS = [
    { address: "192.0.2.21", name: "living-room-tv" },
    { address: "192.0.2.34", name: "alex-laptop" },
    { address: "192.0.2.47", name: "ana-phone" },
    { address: "192.0.2.52", name: "printer" }
];

const wave = (base: number, swing: number, phase: number) =>
    Array.from({ length: BUCKETS }, (_, n) => Math.round(base + swing * Math.sin((n + phase) / 4) + ((n * 7) % 5) * 3));

function insights(ctx: SceneContext) {
    const allowed = wave(140, 60, 0);
    const blocked = wave(38, 18, 2);
    const queries = [...allowed, ...blocked].reduce((sum, value) => sum + value, 0);
    const blockedTotal = blocked.reduce((sum, value) => sum + value, 0);
    const from = Math.floor(ctx.now / BUCKET) * BUCKET - (BUCKETS - 1) * BUCKET;
    const rows = [
        ["192.0.2.34", "updates.example.com", "allowed", "RESOLVED", ""],
        ["192.0.2.21", "ads.tracker.example", "blocked", "BLOCKED", "ads"],
        ["192.0.2.47", "mail.example.org", "allowed", "CACHED", ""],
        ["192.0.2.21", "metrics.example.net", "blocked", "BLOCKED", "trackers"],
        ["192.0.2.52", "time.example.com", "allowed", "RESOLVED", ""],
        ["192.0.2.34", "cdn.example.net", "allowed", "CACHED", ""]
    ].map(([client, domain, outcome, reason, list], n) => ({
        time: new Date(ctx.now - n * 9_000).toISOString(),
        at: ctx.now - n * 9_000,
        client,
        clientName: CLIENTS.find((one) => one.address === client)?.name ?? "",
        domain,
        type: "A",
        outcome,
        reason: reason === "RESOLVED" ? `RESOLVED (${UPSTREAM})` : reason,
        durationMs: outcome === "blocked" ? 0 : 3 + n,
        via: reason === "CACHED" ? "cache" : outcome === "blocked" ? "blocked" : UPSTREAM,
        list
    }));
    return {
        insights: {
            stats: {
                queries,
                blocked: blockedTotal,
                blockedPercent: Math.round((blockedTotal / queries) * 1000) / 10,
                timeline: { from, bucketMs: BUCKET, allowed, blocked },
                clientSeries: CLIENTS.slice(0, 3).map((client, n) => ({
                    client: client.address,
                    name: client.name,
                    counts: wave(50 - n * 12, 20, n * 3)
                })),
                queryTypes: [
                    { name: "A", count: Math.round(queries * 0.62) },
                    { name: "AAAA", count: Math.round(queries * 0.29) },
                    { name: "HTTPS", count: Math.round(queries * 0.09) }
                ],
                destinations: [
                    { name: "cache", count: Math.round(queries * 0.55) },
                    { name: UPSTREAM, count: Math.round(queries * 0.25) }
                ],
                blockedBy: [
                    { name: "ads", count: Math.round(blockedTotal * 0.58) },
                    { name: "trackers", count: Math.round(blockedTotal * 0.34) },
                    { name: "malware", count: Math.round(blockedTotal * 0.08) }
                ],
                topPermitted: [
                    { name: "updates.example.com", count: 812 },
                    { name: "cdn.example.net", count: 640 },
                    { name: "mail.example.org", count: 402 },
                    { name: "time.example.com", count: 288 }
                ],
                topBlocked: [
                    { name: "ads.tracker.example", count: 301 },
                    { name: "metrics.example.net", count: 214 },
                    { name: "pixel.example.org", count: 97 }
                ],
                topClients: CLIENTS.map((client, n) => ({ name: client.address, count: 1400 - n * 310 })),
                topBlockedClients: CLIENTS.slice(0, 2).map((client, n) => ({ name: client.address, count: 420 - n * 150 })),
                clients: CLIENTS
            },
            log: { rows, page: 0, hasMore: true },
            pause: { enabled: true, secondsLeft: null },
            logOff: false
        }
    };
}

function history(ctx: SceneContext) {
    const days = 30;
    const allowed = Array.from({ length: days }, (_, n) => 21_000 + ((n * 37) % 11) * 900);
    const blocked = Array.from({ length: days }, (_, n) => 5_200 + ((n * 23) % 7) * 400);
    const queries = [...allowed, ...blocked].reduce((sum, value) => sum + value, 0);
    const blockedTotal = blocked.reduce((sum, value) => sum + value, 0);
    return {
        history: {
            days,
            queries,
            blocked: blockedTotal,
            blockedPercent: Math.round((blockedTotal / queries) * 1000) / 10,
            timeline: { from: ctx.now - days * 86_400_000, bucketMs: 86_400_000, allowed, blocked },
            topPermitted: [{ name: "updates.example.com", count: 24_100 }],
            topBlocked: [{ name: "ads.tracker.example", count: 9_300 }],
            topClients: [{ name: "192.0.2.34", count: 41_000 }],
            topBlockedClients: [{ name: "192.0.2.21", count: 12_800 }],
            blockedBy: [{ name: "ads", count: Math.round(blockedTotal * 0.6) }],
            clientNames: CLIENTS
        }
    };
}

const wire = (value: unknown) => ({ value: toWire(value) });

/** The page `/apps/network-filter` draws once the filter is blocking. */
function NetworkFilter() {
    const t = useTranslations("dnsBlocker");
    const tAdmin = useTranslations("admin");
    const brands = routerBrandsFor("dns").map((entry) => ({
        value: entry.id,
        label: routerGuideIn(tAdmin, entry).label
    }));
    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col">
            <PageHeader title={t("page.title")} description={t("page.description")} />
            <DnsBlockerProvider initial={dns.DEFAULT_DNS_SETTINGS}>
                <DnsOverviewSection brands={brands} />
            </DnsBlockerProvider>
        </div>
    );
}

export const networkFilter = defineScene({
    id: "network-filter",
    path: "/apps/network-filter",
    api: (ctx) => ({
        "GET /api/dns-blocker/status": () =>
            wire({ status: { state: "blocking", address: ADDRESS, settings: dns.DEFAULT_DNS_SETTINGS, stale: false } }),
        "GET /api/dns-blocker/insights": () => wire(insights(ctx)),
        "GET /api/dns-blocker/tail": () => wire({ rows: [] }),
        "GET /api/dns-blocker/lists": () =>
            wire({
                metrics: {
                    lists: [
                        { name: "ads", count: 182_400 },
                        { name: "trackers", count: 64_900 },
                        { name: "malware", count: 31_200 }
                    ],
                    listed: 278_500,
                    lastRefresh: ctx.now - 3 * 3_600_000,
                    failedDownloads: 0
                }
            }),
        "GET /api/dns-blocker/history": () => wire(history(ctx)),
        "GET /api/dns-blocker/clients": () => wire({ clients: CLIENTS, logOff: false }),
        "GET /api/dns-blocker/reputation": () => wire({ off: "integrationOff", flagged: [] })
    }),
    render: () => (
        <Chrome>
            <NetworkFilter />
        </Chrome>
    )
});
