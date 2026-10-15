/**
 * Scans: queued by a person or by a server's schedule, started one at a time
 * per server (a partial unique index on running rows is the lock), run in a
 * one-off container, and stored compactly - findings capped per scan, history
 * pruned per server and kind.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { promisify } from "node:util";
import * as parse from "../model/parse";
import * as specs from "../model/specs";
import { gunzip, gzip } from "node:zlib";
import { shortHash } from "@polaris/deploy";
import {
    exportImage,
    listExports,
    portsFor,
    removeExport,
    runHostAction,
    runOneShot,
    ScanFailure,
    TIMEOUT_MS,
    type ScanTarget
} from "./runner";

const zip = promisify(gzip);
const unzip = promisify(gunzip);

export type ScanKind = "malware" | "files" | "audit" | "image";

const MAX_FINDINGS = 500;
const KEEP_PER_KIND = 30;
const HISTORY_MS = 90 * 24 * 60 * 60_000;
/** Past every deadline a scan runs under (one-shots share `TIMEOUT_MS`, the
 *  daemon stops an export within the hour), so only a scan nothing is running
 *  any more is ever marked lost. */
const STALE_MS = TIMEOUT_MS + 3 * 60 * 60_000;
/** Scans running at once in this process, each on a different server. */
const MAX_PARALLEL = 4;
/** A baseline or inventory past this, compressed, is refused, not stored. */
const MAX_PAYLOAD = 8 * 1024 * 1024;

const TARGET_SELECT = {
    id: true,
    ownerId: true,
    kind: true,
    hostId: true,
    runtime: true,
    proxyNetwork: true
} as const;

/** The engine's name for one of an app's volumes (`polaris-<hash>_<source>`),
 *  the same rule the deploy pipeline names it by. */
export function volumeDockerName(applicationId: string, source: string): string {
    return `polaris-${shortHash(applicationId, 8)}_${source}`;
}

interface VolumeRow {
    readonly id: string;
    readonly dockerName: string;
    readonly label: string;
}

async function volumesOf(targetId: string, ids?: readonly string[]): Promise<VolumeRow[]> {
    const rows = await prisma.volume.findMany({
        where: {
            targetId,
            kind: "volume",
            source: { not: null },
            applicationId: { not: null },
            ...(ids ? { id: { in: [...ids] } } : {})
        },
        select: {
            id: true,
            name: true,
            source: true,
            applicationId: true,
            application: { select: { name: true } }
        },
        orderBy: { createdAt: "asc" },
        take: 200
    });
    return rows.map((row) => ({
        id: row.id,
        dockerName: volumeDockerName(row.applicationId!, row.source!),
        label: `${row.application?.name ?? "?"} / ${row.name}`
    }));
}

async function appsOf(targetId: string) {
    return prisma.application.findMany({
        where: { targetId },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: 200
    });
}

/** The image an app is running now: its newest running deployment's. */
async function imageOf(applicationId: string): Promise<string | null> {
    const row = await prisma.deployment.findFirst({
        where: {
            deployableType: "application",
            deployableId: applicationId,
            status: "running",
            imageTag: { not: null }
        },
        orderBy: { createdAt: "desc" },
        select: { imageTag: true }
    });
    return row?.imageTag ?? null;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

export async function listServers() {
    const targets = await prisma.deployTarget.findMany({
        select: { id: true, name: true, kind: true, securitySetting: true },
        orderBy: { createdAt: "asc" },
        take: 100
    });
    return targets.map((t) => ({
        id: t.id,
        name: t.name,
        local: t.kind === "local",
        everyHours: t.securitySetting?.everyHours ?? 0,
        updates: t.securitySetting?.updates ?? "unknown",
        distro: t.securitySetting?.distro ?? null
    }));
}

export async function serverOverview(targetId: string) {
    const [volumes, apps, scans, quarantine, baselines] = await Promise.all([
        volumesOf(targetId),
        appsOf(targetId),
        prisma.securityScan.findMany({
            where: { targetId },
            orderBy: { createdAt: "desc" },
            take: 40,
            select: {
                id: true,
                kind: true,
                label: true,
                state: true,
                summary: true,
                error: true,
                createdAt: true,
                finishedAt: true
            }
        }),
        prisma.securityQuarantine.findMany({
            where: { targetId, state: "held" },
            orderBy: { createdAt: "desc" },
            take: 100,
            select: { id: true, volumeId: true, path: true, signature: true, createdAt: true }
        }),
        prisma.securityBaseline.findMany({
            where: { targetId },
            select: {
                id: true,
                volumeId: true,
                subpath: true,
                label: true,
                files: true,
                createdAt: true
            },
            take: 100
        })
    ]);
    return {
        volumes: volumes.map(({ id, label }) => ({ id, label })),
        apps,
        scans: scans.map((scan) => ({ ...scan, summary: safeJson(scan.summary) })),
        quarantine,
        baselines
    };
}

export async function scanFindings(scanId: string) {
    return prisma.securityFinding.findMany({
        where: { scanId },
        orderBy: { position: "asc" },
        take: MAX_FINDINGS,
        select: {
            id: true,
            severity: true,
            title: true,
            location: true,
            volumeId: true,
            fixedIn: true,
            url: true
        }
    });
}

/** The inventory a scan produced, as the JSON it was. */
export async function sbomOf(scanId: string): Promise<{ name: string; body: Buffer } | null> {
    const scan = await prisma.securityScan.findFirst({
        where: { id: scanId, kind: "image", state: "done" },
        select: { payload: true, label: true }
    });
    if (!scan?.payload) return null;
    const safe = scan.label.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "image";
    return { name: `${safe}.cdx.json`, body: await unzip(Buffer.from(scan.payload)) };
}

function safeJson(text: string): Record<string, unknown> {
    try {
        const value: unknown = JSON.parse(text);
        return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/* -------------------------------------------------------------------------- */
/* Queueing                                                                    */
/* -------------------------------------------------------------------------- */

export async function enqueue(
    targetId: string,
    kind: ScanKind,
    label: string,
    input: unknown,
    requestedById: string | null
): Promise<string> {
    const scan = await prisma.securityScan.create({
        data: { targetId, kind, label, input: JSON.stringify(input), requestedById },
        select: { id: true }
    });
    void drain().catch((caught) => console.error("polaris: security scans:", caught));
    return scan.id;
}

export async function queueMalware(
    targetId: string,
    chosen: readonly { volumeId: string; subpath: string }[],
    userId: string | null
): Promise<string> {
    const volumes = await volumesOf(
        targetId,
        chosen.map((c) => c.volumeId)
    );
    if (volumes.length === 0) throw new ScanFailure("noVolumes");
    const label = volumes.length === 1 ? volumes[0]!.label : `${volumes.length} volumes`;
    return enqueue(targetId, "malware", label, { volumes: chosen }, userId);
}

export async function queueFiles(
    targetId: string,
    volumeId: string,
    subpath: string,
    mode: "baseline" | "check",
    userId: string | null
): Promise<string> {
    const [volume] = await volumesOf(targetId, [volumeId]);
    if (!volume) throw new ScanFailure("noVolumes");
    if (mode === "check") {
        const baseline = await prisma.securityBaseline.findUnique({
            where: { targetId_volumeId_subpath: { targetId, volumeId, subpath } },
            select: { id: true }
        });
        if (!baseline) throw new ScanFailure("noBaseline");
    }
    const label = subpath ? `${volume.label} / ${subpath}` : volume.label;
    return enqueue(targetId, "files", label, { volumeId, subpath, mode }, userId);
}

export async function queueImage(targetId: string, applicationId: string, userId: string | null) {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, targetId },
        select: { name: true }
    });
    if (!app) throw new ScanFailure("noApp");
    return enqueue(targetId, "image", app.name, { applicationId }, userId);
}

/* -------------------------------------------------------------------------- */
/* Running                                                                     */
/* -------------------------------------------------------------------------- */

async function claim(scanId: string): Promise<boolean> {
    try {
        const { count } = await prisma.securityScan.updateMany({
            where: { id: scanId, state: "queued" },
            data: { state: "running", startedAt: new Date() }
        });
        return count === 1;
    } catch {
        // Another scan is running on this server (the partial unique index).
        return false;
    }
}

const active = new Set<string>();
let draining: Promise<void> | null = null;
let again = false;

/**
 * Start every queued scan whose server is free, oldest first, up to
 * `MAX_PARALLEL` at once. Resolves once they are started, not finished; each
 * one that ends drains again.
 */
export function drain(): Promise<void> {
    if (draining) {
        again = true;
        return draining;
    }
    draining = (async () => {
        try {
            do {
                again = false;
                await startFree();
            } while (again);
        } finally {
            draining = null;
        }
    })();
    return draining;
}

async function startFree(): Promise<void> {
    while (active.size < MAX_PARALLEL) {
        const queued = await prisma.securityScan.findMany({
            where: { state: "queued" },
            orderBy: { createdAt: "asc" },
            take: 50,
            select: { id: true, targetId: true }
        });
        const busy = new Set(
            (
                await prisma.securityScan.findMany({
                    where: { state: "running" },
                    select: { targetId: true }
                })
            ).map((row) => row.targetId)
        );
        const next = queued.find((scan) => !busy.has(scan.targetId));
        if (!next || !(await claim(next.id))) return;
        active.add(next.id);
        void execute(next.id)
            .catch((caught) => console.error(`polaris: security scan ${next.id}:`, caught))
            .finally(() => {
                active.delete(next.id);
                void drain().catch((caught) => console.error("polaris: security scans:", caught));
            });
    }
}

async function execute(scanId: string): Promise<void> {
    const scan = await prisma.securityScan.findUniqueOrThrow({
        where: { id: scanId },
        select: { id: true, kind: true, input: true, target: { select: TARGET_SELECT } }
    });
    try {
        const input = safeJson(scan.input);
        const result =
            scan.kind === "malware"
                ? await runMalware(scan.target, input)
                : scan.kind === "files"
                  ? await runFiles(scan.target, input)
                  : scan.kind === "audit"
                    ? await runAudit(scan.target)
                    : await runImage(scan.target, input, scan.id);
        await prisma.$transaction([
            prisma.securityFinding.createMany({
                data: result.findings.slice(0, MAX_FINDINGS).map((finding, position) => ({
                    ...finding,
                    scanId,
                    position
                }))
            }),
            prisma.securityScan.update({
                where: { id: scanId },
                data: {
                    state: "done",
                    finishedAt: new Date(),
                    summary: JSON.stringify(result.summary),
                    payload: result.payload ?? null
                }
            })
        ]);
    } catch (caught) {
        const code = caught instanceof ScanFailure ? caught.code : "failed";
        if (!(caught instanceof ScanFailure))
            console.error(`polaris: security scan ${scanId}:`, caught);
        await prisma.securityScan.update({
            where: { id: scanId },
            data: { state: "failed", finishedAt: new Date(), error: code }
        });
    }
}

interface FindingRow {
    severity: string;
    title: string;
    location: string;
    volumeId?: string | null;
    fixedIn?: string | null;
    url?: string | null;
}

interface ScanResult {
    findings: FindingRow[];
    summary: Record<string, unknown>;
    payload?: Buffer;
}

async function runMalware(target: ScanTarget, input: Record<string, unknown>): Promise<ScanResult> {
    const chosen = Array.isArray(input.volumes)
        ? (input.volumes as { volumeId: string; subpath: string }[])
        : [];
    const rows = await volumesOf(
        target.id,
        chosen.map((c) => c.volumeId)
    );
    const volumes = chosen.flatMap((c) => {
        const row = rows.find((r) => r.id === c.volumeId);
        return row ? [{ row, subpath: c.subpath }] : [];
    });
    if (volumes.length === 0) throw new ScanFailure("noVolumes");
    const { exitCode, log } = await runOneShot(
        await portsFor(target),
        specs.malwareSpec(
            volumes.map((v) => ({ dockerName: v.row.dockerName, subpath: v.subpath }))
        )
    );
    const report = parse.parseMalwareLog(log);
    if (report.noSignatures || exitCode === 20) throw new ScanFailure("noSignatures");
    if (exitCode !== 0 && exitCode !== 1) throw new ScanFailure("scanError");
    return {
        findings: report.hits
            .filter((hit) => volumes[hit.volume])
            .map((hit) => ({
                severity: "found",
                title: hit.signature,
                location: `${volumes[hit.volume]!.row.label}: ${hit.path}`,
                volumeId: volumes[hit.volume]!.row.id,
                fixedIn: hit.path
            })),
        summary: { found: report.hits.length, staleSignatures: report.staleSignatures }
    };
}

async function runFiles(target: ScanTarget, input: Record<string, unknown>): Promise<ScanResult> {
    const volumeId = String(input.volumeId ?? "");
    const subpath = String(input.subpath ?? "");
    const [volume] = await volumesOf(target.id, [volumeId]);
    if (!volume) throw new ScanFailure("noVolumes");
    const { exitCode, log } = await runOneShot(
        await portsFor(target),
        specs.filesSpec({ dockerName: volume.dockerName, subpath })
    );
    if (exitCode === 21) throw new ScanFailure("tooManyFiles");
    if (exitCode === 10) throw new ScanFailure("noFolder");
    const report = parse.parseFilesLog(log);
    if (exitCode !== 0 || !report.complete) throw new ScanFailure("scanError");
    const manifest = await zip(parse.encodeManifest(report.manifest));
    if (manifest.length > MAX_PAYLOAD) throw new ScanFailure("tooManyFiles");
    const key = { targetId_volumeId_subpath: { targetId: target.id, volumeId, subpath } };
    const label = subpath ? `${volume.label} / ${subpath}` : volume.label;
    if (input.mode !== "check") {
        await prisma.securityBaseline.upsert({
            where: key,
            create: {
                targetId: target.id,
                volumeId,
                subpath,
                label,
                manifest,
                files: report.manifest.size
            },
            update: { label, manifest, files: report.manifest.size, createdAt: new Date() }
        });
        return { findings: [], summary: { mode: "baseline", files: report.manifest.size } };
    }
    const baseline = await prisma.securityBaseline.findUnique({
        where: key,
        select: { manifest: true }
    });
    if (!baseline) throw new ScanFailure("noBaseline");
    const before = parse.decodeManifest(
        (await unzip(Buffer.from(baseline.manifest))).toString("utf8")
    );
    const diff = parse.diffManifests(before, report.manifest, 150);
    return {
        findings: [
            ...diff.changed.map((path) => ({ severity: "changed", title: path, location: label })),
            ...diff.added.map((path) => ({ severity: "added", title: path, location: label })),
            ...diff.removed.map((path) => ({ severity: "removed", title: path, location: label }))
        ],
        summary: { mode: "check", files: report.manifest.size, ...diff.totals }
    };
}

async function runAudit(target: ScanTarget): Promise<ScanResult> {
    const { exitCode, output } = await runHostAction(target, "audit");
    if (exitCode === 20) throw new ScanFailure("noTool");
    const report = parse.parseAuditReport(output);
    if (exitCode !== 0 || report.score === null) throw new ScanFailure("scanError");
    return {
        findings: report.items.map((item) => ({
            severity: item.kind,
            title: item.text,
            location: item.test,
            fixedIn: item.detail,
            url: `https://cisofy.com/lynis/controls/${encodeURIComponent(item.test)}/`
        })),
        summary: {
            score: report.score,
            os: report.os,
            tests: report.testsRun,
            warnings: report.items.filter((i) => i.kind === "warning").length,
            suggestions: report.items.filter((i) => i.kind === "suggestion").length
        }
    };
}

async function runImage(
    target: ScanTarget,
    input: Record<string, unknown>,
    scanId: string
): Promise<ScanResult> {
    // Only the image this app's own running release names is ever exported.
    const image = await imageOf(String(input.applicationId ?? ""));
    if (!image) throw new ScanFailure("notRunning");
    if (!parse.isImageRef(image)) throw new ScanFailure("imageMissing");
    const volume = specs.exportVolumeName(scanId);
    const ports = await portsFor(target);
    let vuln: { log: string };
    let sbom: { log: string };
    try {
        const deadline = Date.now() + TIMEOUT_MS;
        await exportImage(target, image, volume);
        vuln = await runOneShot(ports, specs.vulnSpec(volume), deadline);
        sbom = await runOneShot(ports, specs.sbomSpec(volume), deadline);
    } finally {
        await removeExport(target, volume).catch((caught) =>
            console.error(`polaris: security scan ${scanId} left its export volume:`, caught)
        );
    }
    const report = parse.parseVulnJson(parse.jsonOf(vuln.log));
    if (!report) throw new ScanFailure("scanError");
    const sbomJson = parse.jsonOf(sbom.log);
    const inventory = parse.summarizeSbom(sbomJson);
    const payload = inventory ? await zip(JSON.stringify(sbomJson)) : undefined;
    return {
        findings: report.items.map((item) => ({
            severity: item.severity,
            title: item.id,
            location: `${item.packageName} ${item.version}`.trim(),
            fixedIn: item.fixedIn,
            url: item.url
        })),
        summary: {
            ...report.counts,
            total: report.total,
            components: inventory?.components ?? null,
            sbom: Boolean(payload && payload.length <= MAX_PAYLOAD)
        },
        payload: payload && payload.length <= MAX_PAYLOAD ? payload : undefined
    };
}

/* -------------------------------------------------------------------------- */
/* Quarantine                                                                  */
/* -------------------------------------------------------------------------- */

export async function quarantineFinding(findingId: string): Promise<void> {
    const finding = await prisma.securityFinding.findUnique({
        where: { id: findingId },
        select: {
            title: true,
            fixedIn: true,
            volumeId: true,
            scan: { select: { kind: true, target: { select: TARGET_SELECT } } }
        }
    });
    if (!finding || finding.scan.kind !== "malware" || !finding.volumeId || !finding.fixedIn) {
        throw new ScanFailure("notFound");
    }
    const target = finding.scan.target;
    const held = await prisma.securityQuarantine.findFirst({
        where: {
            targetId: target.id,
            volumeId: finding.volumeId,
            path: finding.fixedIn,
            state: "held"
        },
        select: { id: true }
    });
    if (held) return;
    const [volume] = await volumesOf(target.id, [finding.volumeId]);
    if (!volume) throw new ScanFailure("noVolumes");
    const row = await prisma.securityQuarantine.create({
        data: {
            targetId: target.id,
            volumeId: volume.id,
            volume: volume.dockerName,
            path: finding.fixedIn,
            signature: finding.title,
            state: "pending"
        },
        select: { id: true }
    });
    const { exitCode } = await runOneShot(
        await portsFor(target),
        specs.quarantineSpec("hold", volume.dockerName, finding.fixedIn, row.id)
    );
    if (exitCode !== 0) {
        await prisma.securityQuarantine.delete({ where: { id: row.id } });
        throw new ScanFailure(exitCode === 2 ? "fileGone" : "quarantineFailed");
    }
    await prisma.securityQuarantine.update({ where: { id: row.id }, data: { state: "held" } });
}

export async function settleQuarantine(id: string, op: "restore" | "delete"): Promise<void> {
    const row = await prisma.securityQuarantine.findFirst({
        where: { id, state: "held" },
        select: { id: true, volume: true, path: true, target: { select: TARGET_SELECT } }
    });
    if (!row) throw new ScanFailure("notFound");
    const { exitCode } = await runOneShot(
        await portsFor(row.target),
        specs.quarantineSpec(op, row.volume, row.path, row.id)
    );
    if (exitCode === 3) throw new ScanFailure("pathTaken");
    if (exitCode !== 0) throw new ScanFailure("quarantineFailed");
    await prisma.securityQuarantine.update({
        where: { id },
        data: { state: op === "restore" ? "restored" : "deleted", settledAt: new Date() }
    });
}

/* -------------------------------------------------------------------------- */
/* Server settings                                                             */
/* -------------------------------------------------------------------------- */

async function targetRow(targetId: string): Promise<ScanTarget> {
    const target = await prisma.deployTarget.findUnique({
        where: { id: targetId },
        select: TARGET_SELECT
    });
    if (!target) throw new ScanFailure("notFound");
    return target;
}

/** Read the host's automatic updates state, or switch it, and record it. */
export async function automaticUpdates(targetId: string, enabled?: boolean) {
    const target = await targetRow(targetId);
    const action =
        enabled === undefined ? "updates-status" : enabled ? "updates-on" : "updates-off";
    const { output } = await runHostAction(target, action);
    const report = parse.parseUpdatesLog(output);
    if (!report.state) throw new ScanFailure("updatesFailed");
    const data = { updates: report.state, distro: report.distro, updatesAt: new Date() };
    await prisma.securitySetting.upsert({
        where: { targetId },
        create: { targetId, ...data },
        update: data
    });
    return report;
}

export async function setSchedule(targetId: string, everyHours: number): Promise<void> {
    await targetRow(targetId);
    await prisma.securitySetting.upsert({
        where: { targetId },
        create: { targetId, everyHours, lastPlanned: new Date() },
        update: { everyHours, lastPlanned: new Date() }
    });
}

/* -------------------------------------------------------------------------- */
/* The job                                                                     */
/* -------------------------------------------------------------------------- */

/** Queue every scan a server's schedule says is due. */
async function planSchedules(now: Date): Promise<void> {
    const due = await prisma.securitySetting.findMany({
        where: { everyHours: { gt: 0 } },
        select: { targetId: true, everyHours: true, lastPlanned: true },
        take: 100
    });
    for (const setting of due) {
        if (
            setting.lastPlanned &&
            now.getTime() - setting.lastPlanned.getTime() < setting.everyHours * 3_600_000
        ) {
            continue;
        }
        await prisma.securitySetting.update({
            where: { targetId: setting.targetId },
            data: { lastPlanned: now }
        });
        const pending = await prisma.securityScan.count({
            where: { targetId: setting.targetId, state: { in: ["queued", "running"] } }
        });
        if (pending > 0) continue;
        const volumes = await volumesOf(setting.targetId);
        if (volumes.length > 0) {
            await queueMalware(
                setting.targetId,
                volumes.slice(0, 20).map((v) => ({ volumeId: v.id, subpath: "" })),
                null
            );
        }
        const baselines = await prisma.securityBaseline.findMany({
            where: { targetId: setting.targetId },
            select: { volumeId: true, subpath: true },
            take: 50
        });
        for (const b of baselines) {
            await queueFiles(setting.targetId, b.volumeId, b.subpath, "check", null).catch(
                () => undefined
            );
        }
        await enqueue(setting.targetId, "audit", "host", {}, null);
        for (const app of await appsOf(setting.targetId)) {
            if (await imageOf(app.id)) await queueImage(setting.targetId, app.id, null);
        }
    }
}

/** Keep the newest scans per server and kind, and nothing older than the window. */
async function prune(now: Date): Promise<void> {
    await prisma.securityScan.deleteMany({
        where: {
            createdAt: { lt: new Date(now.getTime() - HISTORY_MS) },
            state: { in: ["done", "failed"] }
        }
    });
    const groups = await prisma.securityScan.groupBy({
        by: ["targetId", "kind"],
        _count: { _all: true },
        having: { id: { _count: { gt: KEEP_PER_KIND } } }
    });
    for (const group of groups) {
        const old = await prisma.securityScan.findMany({
            where: {
                targetId: group.targetId,
                kind: group.kind,
                state: { in: ["done", "failed"] }
            },
            orderBy: { createdAt: "desc" },
            skip: KEEP_PER_KIND,
            select: { id: true },
            take: 500
        });
        await prisma.securityScan.deleteMany({ where: { id: { in: old.map((row) => row.id) } } });
    }
    await prisma.securityQuarantine.deleteMany({
        where: {
            state: { in: ["restored", "deleted"] },
            settledAt: { lt: new Date(now.getTime() - HISTORY_MS) }
        }
    });
}

/** When each server's export volumes were last swept, in this process. */
const lastSwept = new Map<string, number>();
const SWEEP_EVERY_MS = 60 * 60_000;

/**
 * Remove image exports a scan left behind (a dashboard that stopped mid-scan
 * never reached its cleanup), at most once an hour per server. The volumes
 * are listed before the running scans are read; see `staleExports`.
 */
async function sweepExports(now: Date): Promise<void> {
    const targets = await prisma.deployTarget.findMany({
        select: TARGET_SELECT,
        orderBy: { createdAt: "asc" },
        take: 100
    });
    for (const target of targets) {
        if (now.getTime() - (lastSwept.get(target.id) ?? 0) < SWEEP_EVERY_MS) continue;
        lastSwept.set(target.id, now.getTime());
        try {
            const listed = await listExports(target);
            if (!listed || listed.length === 0) continue;
            const running = await prisma.securityScan.findMany({
                where: { targetId: target.id, state: "running" },
                select: { id: true }
            });
            for (const volume of specs.staleExports(
                listed,
                running.map((scan) => scan.id)
            )) {
                await removeExport(target, volume);
            }
        } catch (caught) {
            console.error(
                `polaris: security scans could not sweep exports on ${target.id}:`,
                caught
            );
        }
    }
}

export async function tick(): Promise<void> {
    const now = new Date();
    // A scan a restarted dashboard left "running" can never finish.
    await prisma.securityScan.updateMany({
        where: { state: "running", startedAt: { lt: new Date(now.getTime() - STALE_MS) } },
        data: { state: "failed", finishedAt: now, error: "lost" }
    });
    await planSchedules(now);
    await drain();
    await prune(now);
    await sweepExports(now);
}
