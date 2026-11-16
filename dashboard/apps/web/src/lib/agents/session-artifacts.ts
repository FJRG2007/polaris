/**
 * A Polar Code session's deliverables: the files its agent leaves in
 * `.polaris/deliverables` (`DELIVERABLES_DIR`), captured with a new version
 * every time their bytes change.
 *
 * A capture runs when a turn ends and when the session's Artifacts tab is
 * opened. The container lists the folder with each file's size and digest, so
 * only what changed is read out of it; each new state is stored where Polar's
 * own files go (`chatTarget()` through `streamFile`, as `lib/polar/attachments`
 * does) and survives the container. Every bound is in `artifact-files.ts`.
 *
 * Only a session in a container on the pool is captured: a session on
 * somebody's own computer or server answers text reads only, and its files are
 * that machine's.
 *
 * Who may read an artifact: whoever may read its session (`getSession`), or
 * somebody it was shared with on its own (`agents.artifact`), or a link to it
 * (`linkReach`). Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { createHash } from "node:crypto";
import { getSession } from "./session-service";
import * as files from "./artifacts/artifact-files";
import { pipeThenDispose } from "@/lib/drive-stream";
import { withContainerPorts } from "./session-ports";
import { containerOf, readAll } from "./session-files";
import { deliverableArtifacts } from "./artifacts/deliverables";
import { grantedCapability, linkReach } from "@/lib/access/grants";
import { chatTarget, removeStoredFiles } from "@/lib/chat/attachments";
import { driverForTarget, LOCAL_TARGET, streamFile } from "@/lib/storage-target";

/** Under POLARIS_DATA_DIR, when the bytes stay on this server: Polar's folder. */
const LOCAL_FOLDER = "polar";
/** Inside whichever storage, legible from a file browser. */
const ROOT = "polaris/polar/sessions";
/** A capture asked for again within this long reuses the last one. */
const RECAPTURE_MS = 10_000;
/** The listing script's output, read back with `readFile`, never `runIn`'s capped text. */
const MAX_LISTING_BYTES = 256 * 1024;

/**
 * Lists the folder as `size<TAB>sha256<TAB>path`, one file a line: regular
 * files only (`find` does not follow a link), nothing hidden, at most one more
 * than a capture takes so the reader can tell the list was cut.
 */
const LISTING_SCRIPT = [
    'cd "$1" 2>/dev/null || exit 3',
    `[ -d ${files.DELIVERABLES_DIR} ] || { : > "$2"; exit 0; }`,
    `cd ${files.DELIVERABLES_DIR}`,
    `find . -type f ! -path '*/.*' | head -n ${files.ARTIFACT_MAX_FILES + 1} | while IFS= read -r f; do`,
    '  f="${f#./}"',
    `  printf '%s\\t%s\\t%s\\n' "$(wc -c < "$f" | tr -d ' ')" "$(sha256sum < "$f" | cut -c1-64)" "$f"`,
    'done > "$2"'
].join("\n");

export type CaptureAnswer =
    | { kind: "captured"; changed: number; tooLarge: number; full: boolean; truncated: boolean }
    | { kind: "unavailable" };

const running = new Map<string, Promise<CaptureAnswer>>();
const lastRun = new Map<string, number>();

/**
 * Capture what changed in a session's deliverables folder. Two asks at once
 * share one run; one soon after the last reuses it.
 */
export function captureSessionArtifacts(sessionId: string, force = false): Promise<CaptureAnswer> {
    const inFlight = running.get(sessionId);
    if (inFlight) return inFlight;
    const last = lastRun.get(sessionId) ?? 0;
    if (!force && Date.now() - last < RECAPTURE_MS) {
        return Promise.resolve({ kind: "captured", changed: 0, tooLarge: 0, full: false, truncated: false });
    }
    const run = capture(sessionId)
        .catch((error): CaptureAnswer => {
            console.error(`[agent-session] ${sessionId}: could not capture its artifacts:`, error);
            return { kind: "unavailable" };
        })
        .finally(() => {
            running.delete(sessionId);
            lastRun.set(sessionId, Date.now());
            // The map stays bounded: a session not asked about for a while is forgotten.
            if (lastRun.size > 5_000) lastRun.clear();
        });
    running.set(sessionId, run);
    return run;
}

async function capture(sessionId: string): Promise<CaptureAnswer> {
    const container = await containerOf(sessionId);
    if (!container) return { kind: "unavailable" };
    const listingPath = `/tmp/polaris-artifacts-${sessionId}.txt`;
    return withContainerPorts(container.hostId, async (ports) => {
        const listed = await ports.runIn(container.containerId, [
            "sh",
            "-c",
            LISTING_SCRIPT,
            "sh",
            container.workdir,
            listingPath
        ]);
        if (listed.code !== 0) return { kind: "unavailable" as const };
        const bytes = await readAll(await ports.readFile(container.containerId, listingPath), MAX_LISTING_BYTES);
        const listing = files.parseListing(bytes ? bytes.toString("utf8") : "");
        const stored = await prisma.agentSessionArtifact.findMany({
            where: { sessionId },
            select: { id: true, path: true, sha256: true, version: true, removedAt: true },
            take: files.ARTIFACT_MAX_FILES * 4
        });
        const plan = files.capturePlan(
            listing.files,
            stored.map((row) => ({ path: row.path, sha256: row.sha256, removed: row.removedAt !== null }))
        );
        if (plan.removed.length > 0) {
            await prisma.agentSessionArtifact.updateMany({
                where: { sessionId, path: { in: plan.removed } },
                data: { removedAt: new Date() }
            });
        }
        if (plan.restored.length > 0) {
            await prisma.agentSessionArtifact.updateMany({
                where: { sessionId, path: { in: plan.restored } },
                data: { removedAt: null }
            });
        }
        const used = await prisma.agentSessionArtifactVersion.aggregate({
            where: { artifact: { sessionId } },
            _sum: { size: true }
        });
        let budget = files.SESSION_ARTIFACT_MAX_BYTES - (used._sum.size ?? 0);
        let changed = 0;
        let full = false;
        const byPath = new Map(stored.map((row) => [row.path, row]));
        for (const file of plan.capture) {
            if (file.size > budget) {
                full = true;
                continue;
            }
            const body = await readAll(
                await ports.readFile(
                    container.containerId,
                    `${container.workdir}/${files.DELIVERABLES_DIR}/${file.path}`
                ),
                files.ARTIFACT_MAX_BYTES
            );
            // Changed again between the listing and the read: the next capture
            // takes the state it settles on.
            if (!body || createHash("sha256").update(body).digest("hex") !== file.sha256) continue;
            await storeVersion(sessionId, file, body, byPath.get(file.path) ?? null);
            budget -= body.byteLength;
            changed += 1;
        }
        return {
            kind: "captured" as const,
            changed,
            tooLarge: plan.tooLarge.length,
            full,
            truncated: listing.truncated
        };
    });
}

async function storeVersion(
    sessionId: string,
    file: files.ListedArtifact,
    body: Buffer,
    existing: { id: string; version: number } | null
): Promise<void> {
    const mediaType = files.artifactMediaType(file.path, body);
    const name = file.path.split("/").at(-1) ?? "file";
    const extension = name.includes(".") ? `.${name.split(".").at(-1)?.replace(/[^A-Za-z0-9]/g, "")}` : "";
    const folder = `${ROOT}/${sessionId}`;
    const storagePath = `${folder}/${crypto.randomUUID()}${extension}`;
    const placed = await streamFile({
        target: await chatTarget(),
        localFolder: LOCAL_FOLDER,
        folder,
        path: storagePath,
        body: new Blob([new Uint8Array(body)]).stream(),
        mime: mediaType,
        declared: body.byteLength,
        what: "session artifact"
    });
    const connectionId = placed.targetId === LOCAL_TARGET ? null : placed.targetId;
    const version = (existing?.version ?? 0) + 1;
    try {
        await prisma.$transaction(async (tx) => {
            const artifact = await tx.agentSessionArtifact.upsert({
                where: { sessionId_path: { sessionId, path: file.path } },
                create: { sessionId, path: file.path, version, size: body.byteLength, sha256: file.sha256, mediaType },
                update: { version, size: body.byteLength, sha256: file.sha256, mediaType, removedAt: null },
                select: { id: true }
            });
            await tx.agentSessionArtifactVersion.create({
                data: {
                    artifactId: artifact.id,
                    version,
                    size: body.byteLength,
                    sha256: file.sha256,
                    connectionId,
                    storagePath
                }
            });
        });
    } catch (error) {
        // Another server took the same version first: its bytes stand.
        await removeStoredFiles([{ connectionId, path: storagePath }], LOCAL_FOLDER).catch(() => undefined);
        throw error;
    }
    if (existing) await pruneVersions(existing.id);
}

/** Keep the newest `ARTIFACT_MAX_VERSIONS`; rows first, bytes second. */
async function pruneVersions(artifactId: string): Promise<void> {
    const stale = await prisma.agentSessionArtifactVersion.findMany({
        where: { artifactId },
        orderBy: { version: "desc" },
        skip: files.ARTIFACT_MAX_VERSIONS,
        take: 100,
        select: { id: true, connectionId: true, storagePath: true }
    });
    if (stale.length === 0) return;
    await prisma.agentSessionArtifactVersion.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
    await removeStoredFiles(
        stale.map((row) => ({ connectionId: row.connectionId, path: row.storagePath })),
        LOCAL_FOLDER
    ).catch(() => undefined);
}

/** The stored bytes of these sessions, to discard before their rows go. */
export async function discardSessionArtifacts(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const rows = await prisma.agentSessionArtifactVersion.findMany({
        where: { artifact: { sessionId: { in: [...sessionIds] } } },
        select: { connectionId: true, storagePath: true },
        take: 50_000
    });
    const ids = await prisma.agentSessionArtifact.findMany({
        where: { sessionId: { in: [...sessionIds] } },
        select: { id: true },
        take: 50_000
    });
    if (ids.length > 0) {
        const { forgetSubject } = await import("@/lib/access/forget");
        await forgetSubject("agents.artifact", ids.map((row) => row.id));
    }
    await prisma.agentSessionArtifact.deleteMany({ where: { sessionId: { in: [...sessionIds] } } });
    await removeStoredFiles(
        rows.map((row) => ({ connectionId: row.connectionId, path: row.storagePath })),
        LOCAL_FOLDER
    ).catch(() => undefined);
}

/** One artifact as a list and a viewer show it. */
export interface ArtifactView {
    readonly id: string;
    readonly path: string;
    readonly name: string;
    readonly kind: files.ArtifactKind;
    readonly mediaType: string;
    readonly size: number;
    readonly version: number;
    readonly updatedAt: string;
    readonly removed: boolean;
    /** Set when the entry stands for a whole bundle directory. */
    readonly bundle: { path: string; fileCount: number } | null;
}

export interface ArtifactVersionView {
    readonly version: number;
    readonly size: number;
    readonly createdAt: string;
}

const ARTIFACT_SELECT = {
    id: true,
    path: true,
    mediaType: true,
    size: true,
    version: true,
    updatedAt: true,
    removedAt: true
} as const;

function toView(row: {
    id: string;
    path: string;
    mediaType: string;
    size: number;
    version: number;
    updatedAt: Date;
    removedAt: Date | null;
}): ArtifactView {
    return {
        id: row.id,
        path: row.path,
        name: row.path.split("/").at(-1) ?? row.path,
        kind: files.artifactKind(row.mediaType),
        mediaType: row.mediaType,
        size: row.size,
        version: row.version,
        updatedAt: row.updatedAt.toISOString(),
        removed: row.removedAt !== null,
        bundle: null
    };
}

/** A session's deliverables as stored, newest first, bundles folded into one. */
export async function listSessionArtifacts(sessionId: string): Promise<ArtifactView[]> {
    const rows = await prisma.agentSessionArtifact.findMany({
        where: { sessionId },
        orderBy: { updatedAt: "desc" },
        take: files.ARTIFACT_MAX_FILES * 4,
        select: ARTIFACT_SELECT
    });
    return deliverableArtifacts(rows.map(toView)).map((entry) => ({ ...entry, bundle: entry.bundle ?? null }));
}

/** One artifact with its versions, newest first. */
export async function artifactDetail(
    artifactId: string
): Promise<{ sessionId: string; artifact: ArtifactView; versions: ArtifactVersionView[] } | null> {
    const row = await prisma.agentSessionArtifact.findUnique({
        where: { id: artifactId },
        select: {
            ...ARTIFACT_SELECT,
            sessionId: true,
            versions: {
                orderBy: { version: "desc" },
                take: files.ARTIFACT_MAX_VERSIONS,
                select: { version: true, size: true, createdAt: true }
            }
        }
    });
    if (!row) return null;
    return {
        sessionId: row.sessionId,
        artifact: toView(row),
        versions: row.versions.map((version) => ({
            version: version.version,
            size: version.size,
            createdAt: version.createdAt.toISOString()
        }))
    };
}

/** The session an artifact belongs to, or null. */
async function sessionOf(artifactId: string): Promise<string | null> {
    const row = await prisma.agentSessionArtifact.findUnique({
        where: { id: artifactId },
        select: { sessionId: true }
    });
    return row?.sessionId ?? null;
}

/**
 * Whether this account may read an artifact: through its session, or through a
 * grant on the artifact itself.
 */
export async function mayReadArtifact(userId: string, artifactId: string): Promise<boolean> {
    const sessionId = await sessionOf(artifactId);
    if (!sessionId) return false;
    if (await getSession(sessionId, userId)) return true;
    const held = await grantedCapability(userId, "agents.artifact", artifactId);
    return core.atLeast("agents.artifact", held, "view");
}

/** The artifact a live link opens, or null. */
export async function artifactOfLink(token: string): Promise<string | null> {
    const reached = await linkReach(token).catch(() => null);
    if (!reached || reached.standing !== "live" || reached.subjectType !== "agents.artifact") return null;
    return reached.subjectId;
}

/** One version's bytes, streamed. The newest when none is named. */
export async function readArtifactVersion(
    artifactId: string,
    version: number | null
): Promise<{
    name: string;
    mediaType: string;
    size: number;
    version: number;
    body: ReadableStream<Uint8Array>;
} | null> {
    const artifact = await prisma.agentSessionArtifact.findUnique({
        where: { id: artifactId },
        select: { path: true, mediaType: true, version: true }
    });
    if (!artifact) return null;
    const row = await prisma.agentSessionArtifactVersion.findUnique({
        where: { artifactId_version: { artifactId, version: version ?? artifact.version } },
        select: { version: true, size: true, connectionId: true, storagePath: true }
    });
    if (!row) return null;
    const driver = await driverForTarget(row.connectionId ?? LOCAL_TARGET, LOCAL_FOLDER);
    let body: ReadableStream<Uint8Array>;
    try {
        body = await driver.readStream(row.storagePath);
    } catch (error) {
        await driver.dispose().catch(() => undefined);
        throw error;
    }
    return {
        name: artifact.path.split("/").at(-1) ?? "file",
        mediaType: artifact.mediaType,
        size: row.size,
        version: row.version,
        body: pipeThenDispose(body, driver)
    };
}
