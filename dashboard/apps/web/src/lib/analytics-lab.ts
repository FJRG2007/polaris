/**
 * Lab performance: Lighthouse audits of a site's home page, run by Polaris in a
 * throwaway container on the local machine.
 *
 * One check is two rows, mobile and desktop, each the median (by performance
 * score) of three Lighthouse runs - the same shape hosted analytics tools report.
 * A person queues a check from the Pages panel, or the site's schedule (daily,
 * weekly or monthly) queues one; the `analytics-lab` job runs whatever is queued,
 * one container at a time, and keeps 90 days or 180 rows per site, whichever is
 * fewer.
 *
 * The container prints one compact `POLARIS_LH {...}` line (scores and metrics
 * only) because its logs are read with a short tail, never the full report.
 * Without the host daemon (the limited edition) nothing can start a container, so
 * audits are refused there and the panel says why.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { lookup } from "node:dns/promises";
import { getCapabilities } from "@polaris/config";
import { parseContainerState, type ComposeSpec, type RuntimePorts } from "@polaris/deploy";

/**
 * Lighthouse CI's client image: Node, Google Chrome and the `lighthouse` CLI.
 * Pinned by digest (tag 0.15.1, 2025-06-25) so the audit never changes under it.
 * No entrypoint of its own (its default command is `lhci --help`), so the spec
 * sets one.
 */
export const LAB_IMAGE =
    "patrickhulce/lhci-client:0.15.1@sha256:558210c5e422a7babaaa09c285b7469da3f00fac1a9880c37883c65d666a7fc9";

export const LAB_STRATEGIES = ["mobile", "desktop"] as const;
export type LabStrategy = (typeof LAB_STRATEGIES)[number];
export const LAB_FREQUENCIES = ["off", "daily", "weekly", "monthly"] as const;
export type LabFrequency = (typeof LAB_FREQUENCIES)[number];
export type LabError = "unreachable" | "private" | "failed" | "limited" | "timeout";

const DAY = 24 * 60 * 60 * 1000;
const FREQUENCY_MS: Readonly<Record<Exclude<LabFrequency, "off">, number>> = {
    daily: DAY,
    weekly: 7 * DAY,
    monthly: 30 * DAY
};
/** Kept per site: 90 days, and never more than 90 checks of two rows. */
export const LAB_KEEP_DAYS = 90;
export const LAB_KEEP_ROWS = 180;
/** Three runs take two to five minutes; past this the container is stopped. */
const RUN_LIMIT_MS = 12 * 60 * 1000;
const POLL_MS = 3_000;
const SUMMARY = "POLARIS_LH ";

// --- the container ------------------------------------------------------------------

/** Reads the three reports and prints the median run's figures on one line. */
const SUMMARIZE = [
    'const fs=require("fs");const runs=[];let err="failed";',
    "for(const i of [1,2,3]){try{",
    'const r=JSON.parse(fs.readFileSync("/tmp/r"+i+".json","utf8"));',
    'if(r.runtimeError&&r.runtimeError.code){err="unreachable";continue}',
    "const c=r.categories||{},a=r.audits||{};",
    'const s=k=>c[k]&&typeof c[k].score==="number"?Math.round(c[k].score*100):null;',
    'const m=k=>a[k]&&typeof a[k].numericValue==="number"?a[k].numericValue:null;',
    'runs.push({performance:s("performance"),accessibility:s("accessibility"),bestPractices:s("best-practices"),seo:s("seo"),',
    'lcp:m("largest-contentful-paint"),cls:m("cumulative-layout-shift"),tbt:m("total-blocking-time"),',
    'fcp:m("first-contentful-paint"),si:m("speed-index"),tti:m("interactive"),version:r.lighthouseVersion||null})',
    "}catch(e){}}",
    `if(!runs.length){console.log("${SUMMARY}"+JSON.stringify({error:err}));process.exit(0)}`,
    "runs.sort((x,y)=>(x.performance??-1)-(y.performance??-1));",
    `console.log("${SUMMARY}"+JSON.stringify(runs[Math.floor(runs.length/2)]))`
].join("");

/** The shell the container runs. The URL and preset arrive through the
 *  environment, so nothing a site holds is ever part of the command line. */
export function labScript(): string {
    return [
        "for i in 1 2 3; do",
        'lighthouse "$POLARIS_LH_URL" --quiet --output=json --output-path=/tmp/r$i.json',
        "--only-categories=performance,accessibility,best-practices,seo --max-wait-for-load=45000",
        '--chrome-flags="--headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu"',
        "$POLARIS_LH_PRESET >/dev/null 2>&1;",
        "done;",
        `node -e '${SUMMARIZE}'`
    ].join(" ");
}

export function labContainerName(runId: string): string {
    return `polaris-lab-${runId.toLowerCase().replace(/[^a-z0-9]/g, "")}`.slice(0, 60);
}

export function labSpec(runId: string, url: string, strategy: LabStrategy): ComposeSpec {
    const name = labContainerName(runId);
    return {
        project: name,
        services: [
            {
                name,
                image: LAB_IMAGE,
                pullPolicy: "missing",
                entrypoint: ["/bin/sh", "-c"],
                command: [labScript()],
                env: {
                    POLARIS_LH_URL: url,
                    POLARIS_LH_PRESET: strategy === "desktop" ? "--preset=desktop" : "",
                    CHROME_PATH: "/usr/bin/google-chrome-stable"
                },
                ports: [],
                volumes: [],
                labels: { "polaris.analytics-lab": "true" },
                networks: [],
                restart: "no",
                // Chrome is the heavy part; bounded so an audit never starves the apps.
                cpus: 2,
                memoryMb: 2048
            }
        ],
        volumes: [],
        networks: []
    };
}

const num = z.number().finite().nullable().catch(null);
const summarySchema = z.union([
    z.object({ error: z.enum(["failed", "unreachable"]) }),
    z.object({
        performance: num,
        accessibility: num,
        bestPractices: num,
        seo: num,
        lcp: num,
        cls: num,
        tbt: num,
        fcp: num,
        si: num,
        tti: num,
        version: z.string().max(40).nullable().catch(null)
    }).strict()
]);

export interface LabFigures {
    readonly performance: number | null;
    readonly accessibility: number | null;
    readonly bestPractices: number | null;
    readonly seo: number | null;
    readonly lcpMs: number | null;
    readonly cls: number | null;
    readonly tbtMs: number | null;
    readonly fcpMs: number | null;
    readonly siMs: number | null;
    readonly ttiMs: number | null;
    readonly lighthouseVersion: string | null;
}

const score = (value: number | null) => (value === null ? null : Math.max(0, Math.min(100, Math.round(value))));
const ms = (value: number | null) => (value === null || value < 0 ? null : Math.min(2_000_000_000, Math.round(value)));

/** The figures in the container's last summary line, or the cause it gave up. */
export function parseLabSummary(log: string): LabFigures | { error: LabError } {
    const line = log
        .split(/\r?\n/)
        .reverse()
        .find((entry) => entry.includes(SUMMARY));
    if (!line) return { error: "failed" };
    let raw: unknown;
    try {
        raw = JSON.parse(line.slice(line.indexOf(SUMMARY) + SUMMARY.length));
    } catch {
        return { error: "failed" };
    }
    const parsed = summarySchema.safeParse(raw);
    if (!parsed.success) return { error: "failed" };
    if ("error" in parsed.data) return { error: parsed.data.error };
    const d = parsed.data;
    return {
        performance: score(d.performance),
        accessibility: score(d.accessibility),
        bestPractices: score(d.bestPractices),
        seo: score(d.seo),
        lcpMs: ms(d.lcp),
        cls: d.cls === null || d.cls < 0 ? null : Math.round(d.cls * 1000) / 1000,
        tbtMs: ms(d.tbt),
        fcpMs: ms(d.fcp),
        siMs: ms(d.si),
        ttiMs: ms(d.tti),
        lighthouseVersion: d.version
    };
}

// --- what is audited ----------------------------------------------------------------

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_SUFFIXES = [".local", ".lan", ".internal", ".home.arpa", ".localhost", ".test", ".invalid"];

/** The page a site's audit opens: its first hostname's home page, or null when
 *  the site has no hostname a public audit could reach. */
export function labUrl(hostnames: readonly string[]): string | null {
    const host = hostnames.map((entry) => entry.trim().toLowerCase()).find((entry) => HOSTNAME.test(entry));
    if (!host || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return null;
    return `https://${host}/`;
}

/** Refuses a hostname that resolves into a private network: an audit is a request
 *  from the server's own network, and is only for pages the internet can open. */
async function reachability(url: string): Promise<LabError | null> {
    try {
        const answers = await lookup(new URL(url).hostname, { all: true });
        if (answers.length === 0) return "unreachable";
        return answers.some((answer) => core.isPrivateIp(answer.address)) ? "private" : null;
    } catch {
        return "unreachable";
    }
}

export function nextLabAt(frequency: LabFrequency, from: number): Date | null {
    return frequency === "off" ? null : new Date(from + FREQUENCY_MS[frequency]);
}

export function labAvailable(): boolean {
    return getCapabilities().docker;
}

// --- reading and queueing -----------------------------------------------------------

export interface LabRunView extends LabFigures {
    readonly id: string;
    readonly url: string;
    readonly strategy: LabStrategy;
    readonly triggeredBy: "scheduled" | "manual";
    readonly status: "queued" | "running" | "ok" | "error";
    readonly error: LabError | null;
    readonly createdAt: string;
    readonly finishedAt: string | null;
}

export interface LabOverview {
    readonly available: boolean;
    readonly url: string | null;
    readonly frequency: LabFrequency;
    readonly nextAt: string | null;
    /** Newest first, bounded by the history window. */
    readonly runs: readonly LabRunView[];
}

const RUN_SELECT = {
    id: true,
    url: true,
    strategy: true,
    triggeredBy: true,
    status: true,
    error: true,
    performance: true,
    accessibility: true,
    bestPractices: true,
    seo: true,
    lcpMs: true,
    cls: true,
    tbtMs: true,
    fcpMs: true,
    siMs: true,
    ttiMs: true,
    lighthouseVersion: true,
    createdAt: true,
    finishedAt: true
} as const;

type RunRow = { [K in keyof typeof RUN_SELECT]: unknown } & { createdAt: Date; finishedAt: Date | null };

function viewOf(row: RunRow): LabRunView {
    const r = row as unknown as Omit<LabRunView, "createdAt" | "finishedAt"> & { createdAt: Date; finishedAt: Date | null };
    return { ...r, createdAt: r.createdAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null };
}

function asFrequency(value: string): LabFrequency {
    return (LAB_FREQUENCIES as readonly string[]).includes(value) ? (value as LabFrequency) : "off";
}

export async function readLab(siteId: string, hostnames: readonly string[], days = LAB_KEEP_DAYS): Promise<LabOverview> {
    const [site, rows] = await Promise.all([
        prisma.analyticsSite.findUnique({ where: { id: siteId }, select: { labFrequency: true, labNextAt: true } }),
        prisma.analyticsLabRun.findMany({
            where: { siteId, createdAt: { gte: new Date(Date.now() - days * DAY) } },
            orderBy: { createdAt: "desc" },
            take: LAB_KEEP_ROWS,
            select: RUN_SELECT
        })
    ]);
    const frequency = asFrequency(site?.labFrequency ?? "off");
    return {
        available: labAvailable(),
        url: labUrl(hostnames),
        frequency,
        nextAt: frequency === "off" ? null : (site?.labNextAt?.toISOString() ?? null),
        runs: rows.map(viewOf)
    };
}

export type QueueRefusal = "limited" | "noUrl" | "busy";

/** Queue a check (both strategies). One check per site at a time. */
export async function queueLabCheck(
    siteId: string,
    hostnames: readonly string[],
    triggeredBy: "scheduled" | "manual"
): Promise<{ refused: QueueRefusal } | { queued: number }> {
    if (!labAvailable()) return { refused: "limited" };
    const url = labUrl(hostnames);
    if (!url) return { refused: "noUrl" };
    const busy = await prisma.analyticsLabRun.count({ where: { siteId, status: { in: ["queued", "running"] } } });
    if (busy > 0) return { refused: "busy" };
    const now = Date.now();
    await prisma.analyticsLabRun.createMany({
        // Desktop a millisecond later, so "newest first" always shows the pair in one order.
        data: LAB_STRATEGIES.map((strategy, index) => ({
            siteId,
            url,
            strategy,
            triggeredBy,
            createdAt: new Date(now + index)
        }))
    });
    return { queued: LAB_STRATEGIES.length };
}

export async function setLabFrequency(siteId: string, frequency: LabFrequency): Promise<void> {
    const site = await prisma.analyticsSite.findUnique({ where: { id: siteId }, select: { labFrequency: true } });
    if (!site || site.labFrequency === frequency) return;
    // The first scheduled check runs on the next pass; then every period after it.
    await prisma.analyticsSite.update({
        where: { id: siteId },
        data: { labFrequency: frequency, labNextAt: frequency === "off" ? null : new Date() }
    });
}

// --- the job ------------------------------------------------------------------------

type PortsFactory = () => Promise<RuntimePorts & { dispose(): Promise<void> }>;

async function localPorts(): Promise<RuntimePorts & { dispose(): Promise<void> }> {
    const { getPorts } = await import("@/lib/deploy/runtime");
    return getPorts({ id: "local", kind: "local", hostId: null, runtime: "compose", proxyNetwork: "" }, "");
}

async function containerLog(ports: RuntimePorts, name: string): Promise<string> {
    const parts: Buffer[] = [];
    await ports.logs(name, (chunk) => void parts.push(Buffer.from(chunk)), { tail: 40 }).catch(() => undefined);
    return Buffer.concat(parts).toString("utf8");
}

/** Run one audit container to the end and read its summary. */
export async function runLabContainer(
    ports: RuntimePorts,
    runId: string,
    url: string,
    strategy: LabStrategy,
    sleep: (ms: number) => Promise<void> = (wait) => new Promise((resolve) => setTimeout(resolve, wait)),
    limitMs = RUN_LIMIT_MS
): Promise<LabFigures | { error: LabError }> {
    const spec = labSpec(runId, url, strategy);
    const name = spec.services[0]!.name;
    await ports.composeDown(spec.project).catch(() => undefined);
    try {
        await ports.composeUp(spec);
        const started = Date.now();
        let missing = 0;
        for (;;) {
            const state = parseContainerState(await ports.inspect(name).catch(() => null));
            if (state.status === "exited" || state.status === "dead") return parseLabSummary(await containerLog(ports, name));
            if (state.status === "unknown" && ++missing >= 5) return { error: "failed" };
            if (Date.now() - started > limitMs) return { error: "timeout" };
            await sleep(POLL_MS);
        }
    } catch (caught) {
        console.error(`polaris: analytics lab run ${runId} could not start:`, caught);
        return { error: "failed" };
    } finally {
        await ports.composeDown(spec.project).catch(() => undefined);
    }
}

async function queueScheduled(now: number): Promise<void> {
    const due = await prisma.analyticsSite.findMany({
        where: { labFrequency: { not: "off" }, labNextAt: { lte: new Date(now) } },
        select: { id: true, hostnames: true, labFrequency: true },
        take: 20
    });
    for (const site of due) {
        let hostnames: string[] = [];
        try {
            const parsed: unknown = JSON.parse(site.hostnames);
            if (Array.isArray(parsed)) hostnames = parsed.filter((entry): entry is string => typeof entry === "string");
        } catch {
            // A broken list audits nothing; the schedule still moves on.
        }
        await queueLabCheck(site.id, hostnames, "scheduled");
        await prisma.analyticsSite.update({
            where: { id: site.id },
            data: { labNextAt: nextLabAt(asFrequency(site.labFrequency), now) }
        });
    }
}

async function trim(siteId: string, now: number): Promise<void> {
    await prisma.analyticsLabRun.deleteMany({ where: { siteId, createdAt: { lt: new Date(now - LAB_KEEP_DAYS * DAY) } } });
    const past = await prisma.analyticsLabRun.findMany({
        where: { siteId },
        orderBy: { createdAt: "desc" },
        skip: LAB_KEEP_ROWS,
        take: 100,
        select: { id: true }
    });
    if (past.length > 0) await prisma.analyticsLabRun.deleteMany({ where: { id: { in: past.map((row) => row.id) } } });
}

/**
 * One pass: queue what the schedules made due, give up on runs a dead worker
 * left `running`, then run up to one check's worth of queued audits.
 */
export async function runAnalyticsLab(
    now = Date.now(),
    portsFactory: PortsFactory = localPorts
): Promise<number | { skipped: string }> {
    if (!labAvailable()) {
        // Nothing can start a container: say so on whatever is waiting instead of leaving it queued.
        await prisma.analyticsLabRun.updateMany({
            where: { status: { in: ["queued", "running"] } },
            data: { status: "error", error: "limited", finishedAt: new Date(now) }
        });
        return { skipped: "no host daemon" };
    }
    await queueScheduled(now);
    await prisma.analyticsLabRun.updateMany({
        where: { status: "running", startedAt: { lt: new Date(now - 2 * RUN_LIMIT_MS) } },
        data: { status: "error", error: "timeout", finishedAt: new Date(now) }
    });
    const queued = await prisma.analyticsLabRun.findMany({
        where: { status: "queued" },
        orderBy: { createdAt: "asc" },
        take: LAB_STRATEGIES.length,
        select: { id: true, siteId: true, url: true, strategy: true }
    });
    if (queued.length === 0) return 0;
    const ports = await portsFactory();
    let ran = 0;
    try {
        for (const row of queued) {
            const claimed = await prisma.analyticsLabRun.updateMany({
                where: { id: row.id, status: "queued" },
                data: { status: "running", startedAt: new Date() }
            });
            if (claimed.count === 0) continue;
            const strategy: LabStrategy = row.strategy === "desktop" ? "desktop" : "mobile";
            const refused = await reachability(row.url);
            const result = refused ? { error: refused } : await runLabContainer(ports, row.id, row.url, strategy);
            await prisma.analyticsLabRun.update({
                where: { id: row.id },
                data:
                    "error" in result
                        ? { status: "error", error: result.error, finishedAt: new Date() }
                        : { status: "ok", error: null, ...result, finishedAt: new Date() }
            });
            await trim(row.siteId, Date.now());
            ran += 1;
        }
    } finally {
        await ports.dispose().catch(() => undefined);
    }
    return ran;
}
