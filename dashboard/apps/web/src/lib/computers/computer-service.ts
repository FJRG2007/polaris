/**
 * The computers a person has paired with Polaris, from pairing to revoking.
 *
 * **Pairing reuses the device sign-in's storage and code** (`CliAuthorization`,
 * `lib/device-code.ts`): somebody signed in presses "Pair a computer", which
 * opens an already-approved request of kind `runner` naming them and shows its
 * short code (and a QR of it). The runner on the PC sends that code to
 * `POST /api/runners/pair` and is handed its credential once. The request is
 * spent by that collection, expires after `PAIR_TTL_MS`, and the route is rate
 * limited per address, so a short code is not a guessable credential.
 *
 * **The credential is the runner's own**, not an API key: it reaches the
 * runner socket and nothing else, is stored only as a SHA-256 hash, belongs to
 * one person, and dies when they revoke the computer (which also closes its
 * socket wherever it is).
 *
 * Server-only.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { randomBytes } from "node:crypto";
import { newUserCode } from "@/lib/device-code";
import { relayNode, sendToRunner } from "./computer-commands";
import { generateToken, hashToken } from "@polaris/core/tokens";

/** How long a pairing code waits for its computer. */
export const PAIR_TTL_MS = 10 * 60_000;

/** A runner is online while its socket is held and it was heard from within
 *  the heartbeat timeout plus some slack for the write. */
export const ONLINE_GRACE_MS = core.RUNNER_LIMITS.heartbeatTimeoutMs + 15_000;

/** How many computers one person may pair. */
export const MAX_COMPUTERS = 20;

/** How often a heartbeat is written down. Every one would be a write per
 *  runner every twenty seconds for a timestamp nobody reads that finely. */
const SEEN_WRITE_MS = 30_000;

/** A computer's name, as typed or as the runner reported its hostname. */
export const computerNameSchema = z.string().trim().min(1).max(60);

export interface ComputerView {
    readonly id: string;
    readonly name: string;
    readonly online: boolean;
    readonly lastSeenAt: string | null;
    readonly platform: string | null;
    readonly osRelease: string | null;
    readonly runnerVersion: string | null;
    readonly clis: ReadonlyArray<{ id: string; version: string; signedIn: string }>;
    readonly tokenHint: string;
    readonly createdAt: string;
    /** What it serves of local models (`local-models`); null on a runner
     *  without the feature. */
    readonly localModels: LocalModelsView | null;
}

export interface LocalModelsView {
    readonly lanHosts: readonly string[];
    readonly servers: ReadonlyArray<{ server: string; host: string; models: number }>;
}

/** A runner's stored capabilities as the screen shows its local models. Pure. */
export function localModelsOf(raw: unknown): LocalModelsView | null {
    if (!core.runnerHasFeature(raw as { features?: string[] } | null, "local-models")) return null;
    const source = raw as { localModels?: unknown; lanHosts?: unknown };
    const served = core.runnerCapabilitiesSchema.shape.localModels.safeParse(source.localModels);
    const hosts = core.runnerCapabilitiesSchema.shape.lanHosts.safeParse(source.lanHosts);
    return {
        lanHosts: hosts.success ? (hosts.data ?? []) : [],
        servers: served.success ? (served.data ?? []).map((one) => ({ server: one.server, host: one.host, models: one.models.length })) : []
    };
}

export function isOnline(
    row: { relayNode: string | null; lastSeenAt: Date | null },
    now: number = Date.now()
): boolean {
    return Boolean(
        row.relayNode && row.lastSeenAt && now - row.lastSeenAt.getTime() <= ONLINE_GRACE_MS
    );
}

function clisOf(raw: unknown): ComputerView["clis"] {
    const parsed = core.runnerCapabilitiesSchema.shape.clis.safeParse(
        (raw as { clis?: unknown } | null)?.clis
    );
    return parsed.success
        ? parsed.data.map(({ id, version, signedIn }) => ({ id, version, signedIn }))
        : [];
}

const VIEW_SELECT = {
    id: true,
    name: true,
    relayNode: true,
    lastSeenAt: true,
    platform: true,
    osRelease: true,
    runnerVersion: true,
    capabilities: true,
    tokenHint: true,
    createdAt: true
} as const;

/** Open a pairing code for this person. One open code per person: pressing
 *  Pair again replaces the last one. */
export async function openPairing(
    userId: string,
    random: (size: number) => Uint8Array = (size) => randomBytes(size),
    now = new Date()
): Promise<{ code: string; expiresAt: Date } | null> {
    await prisma.cliAuthorization.deleteMany({ where: { expiresAt: { lt: now } } });
    await prisma.cliAuthorization.deleteMany({ where: { userId, kind: "runner" } });
    const expiresAt = new Date(now.getTime() + PAIR_TTL_MS);
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = newUserCode(random);
        try {
            await prisma.cliAuthorization.create({
                data: {
                    codeHash: hashToken(generateToken()),
                    userCode: code,
                    status: "approved",
                    userId,
                    deviceName: "",
                    clientVersion: null,
                    scopes: "[]",
                    kind: "runner",
                    expiresAt
                }
            });
            return { code, expiresAt };
        } catch (caught) {
            if ((caught as { code?: string } | null)?.code !== "P2002") throw caught;
        }
    }
    return null;
}

/** Whether this person's pairing code is still waiting for its computer. */
export async function pairingWaiting(userId: string, code: string): Promise<boolean> {
    const row = await prisma.cliAuthorization.findFirst({
        where: { userCode: code, userId, kind: "runner", expiresAt: { gt: new Date() } },
        select: { id: true }
    });
    return Boolean(row);
}

/**
 * A runner presenting a pairing code. Returns its credential exactly once, or
 * null for a code that is wrong, spent, expired, or whose owner can no longer
 * sign in.
 */
export async function claimPairing(input: {
    readonly code: string;
    readonly name: string;
    readonly now?: Date;
}): Promise<{ runnerId: string; token: string; userId: string } | null> {
    const now = input.now ?? new Date();
    const row = await prisma.cliAuthorization.findUnique({ where: { userCode: input.code } });
    if (
        !row ||
        row.kind !== "runner" ||
        row.status !== "approved" ||
        !row.userId ||
        row.expiresAt <= now
    )
        return null;
    // Spent before anything is minted: two runners racing on one code must not
    // both walk away with a credential.
    const spent = await prisma.cliAuthorization.deleteMany({ where: { id: row.id, kind: "runner" } });
    if (spent.count === 0) return null;
    const owner = await prisma.user.findUnique({
        where: { id: row.userId },
        select: { id: true, bannedAt: true, disabledAt: true }
    });
    if (!owner || owner.bannedAt || owner.disabledAt) return null;
    const held = await prisma.agentRunner.count({ where: { userId: owner.id } });
    if (held >= MAX_COMPUTERS) return null;
    const token = `plr_run_${generateToken()}`;
    const created = await prisma.agentRunner.create({
        data: {
            userId: owner.id,
            name: input.name,
            tokenHash: hashToken(token),
            tokenHint: token.slice(-4)
        },
        select: { id: true }
    });
    return { runnerId: created.id, token, userId: owner.id };
}

/** The runner a credential belongs to, while its owner may still sign in. */
export async function authenticateRunner(token: string): Promise<core.RunnerIdentity | null> {
    if (!token || token.length > 200) return null;
    const row = await prisma.agentRunner.findUnique({
        where: { tokenHash: hashToken(token) },
        select: { id: true, userId: true, user: { select: { bannedAt: true, disabledAt: true } } }
    });
    if (!row || row.user.bannedAt || row.user.disabledAt) return null;
    return { runnerId: row.id, userId: row.userId };
}

/** The sidecar on this node took or lost a runner's socket. Going offline
 *  only clears a row this node still holds, so a runner that moved to another
 *  node is not marked offline by the old one. */
export async function recordPresence(
    runnerId: string,
    online: boolean,
    now = new Date()
): Promise<void> {
    const node = relayNode();
    if (online) {
        await prisma.agentRunner.updateMany({
            where: { id: runnerId },
            data: { relayNode: node, connectedAt: now, lastSeenAt: now }
        });
        return;
    }
    await prisma.agentRunner.updateMany({
        where: { id: runnerId, relayNode: node },
        data: { relayNode: null, connectedAt: null, lastSeenAt: now }
    });
}

/** A heartbeat: written down at most every `SEEN_WRITE_MS`. */
export async function recordSeen(runnerId: string, now = new Date()): Promise<void> {
    await prisma.agentRunner.updateMany({
        where: {
            id: runnerId,
            OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: new Date(now.getTime() - SEEN_WRITE_MS) } }]
        },
        data: { lastSeenAt: now, relayNode: relayNode() }
    });
}

export async function recordHello(runnerId: string, runnerVersion: string): Promise<void> {
    await prisma.agentRunner.updateMany({ where: { id: runnerId }, data: { runnerVersion } });
}

export async function recordCapabilities(
    runnerId: string,
    capabilities: core.RunnerCapabilities
): Promise<void> {
    const { v: _version, type: _type, ...stored } = capabilities;
    await prisma.agentRunner.updateMany({
        where: { id: runnerId },
        data: {
            platform: capabilities.os.platform,
            osRelease: capabilities.os.release,
            arch: capabilities.os.arch,
            capabilities: stored as object,
            lastSeenAt: new Date()
        }
    });
}

export async function listComputers(userId: string, now = Date.now()): Promise<ComputerView[]> {
    const rows = await prisma.agentRunner.findMany({
        where: { userId },
        select: VIEW_SELECT,
        orderBy: { createdAt: "asc" },
        take: MAX_COMPUTERS
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        online: isOnline(row, now),
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
        platform: row.platform,
        osRelease: row.osRelease,
        runnerVersion: row.runnerVersion,
        clis: clisOf(row.capabilities),
        tokenHint: row.tokenHint,
        createdAt: row.createdAt.toISOString(),
        localModels: localModelsOf(row.capabilities)
    }));
}

export async function renameComputer(userId: string, id: string, name: string): Promise<boolean> {
    const renamed = await prisma.agentRunner.updateMany({ where: { id, userId }, data: { name } });
    return renamed.count > 0;
}

/** Forget a computer: its credential stops working at once and its socket is
 *  closed wherever it is. Its finished sessions stay readable. */
export async function revokeComputer(userId: string, id: string): Promise<boolean> {
    const row = await prisma.agentRunner.findFirst({ where: { id, userId }, select: { id: true } });
    if (!row) return false;
    // Closed while the row still says where the socket is.
    await sendToRunner(id, { type: "close" });
    await prisma.agentRunner.deleteMany({ where: { id, userId } });
    return true;
}

/** The person's computer a session would run on, if it is theirs, and
 *  whether it is online right now. */
export async function computerFor(
    userId: string,
    runnerId: string
): Promise<{ id: string; name: string; online: boolean } | null> {
    const row = await prisma.agentRunner.findFirst({
        where: { id: runnerId, userId },
        select: { id: true, name: true, relayNode: true, lastSeenAt: true }
    });
    return row ? { id: row.id, name: row.name, online: isOnline(row) } : null;
}
