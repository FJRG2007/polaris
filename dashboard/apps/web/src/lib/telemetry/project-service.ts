/**
 * The things that report, and the address each of them reports to.
 *
 * A telemetry project exists so a DSN exists. That string is the entire
 * integration: an application points the Sentry client it already has at it and
 * starts reporting here, with no agent to install and no format to learn. It is
 * also why the key in it is treated as public - it ships inside the browser
 * bundle of every web application that reports, so it names a project and proves
 * nothing. Rotating it is how a published one is taken back.
 *
 * Polaris has one of its own, made on first use and not deletable, because the
 * dashboard reports its own crashes into it and a missing row would mean losing
 * the one failure nobody else is watching for.
 */

import * as core from "@polaris/core";
import { prisma } from "@polaris/db";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** The slug and name Polaris' own project always has. */
const SYSTEM_SLUG = "polaris";

export interface TelemetryActor {
    readonly id: string;
    readonly isAdmin: boolean;
}

/** The rules a report is admitted by, as the screen edits them. */
export interface ReporterSettings {
    readonly reporters: core.TelemetryReporters;
    readonly allowedCidrs: readonly string[];
    readonly allowedUserAgents: readonly string[];
    readonly deniedUserAgents: readonly string[];
    readonly requireSecret: boolean;
    /** Whether a key has been minted. The key itself is shown once and stored as
     *  a hash, so this and its last few characters are all there is to show. */
    readonly hasSecret: boolean;
    readonly secretTail: string | null;
}

/** What was turned away. Null throughout on a project that has never refused
 *  anything, which is what most of them look like. */
export interface RefusalSummary {
    readonly count: number;
    readonly at: string | null;
    readonly ip: string | null;
    readonly agent: string | null;
    readonly reason: core.IngestRefusal;
}

export interface ProjectSummary {
    readonly id: string;
    readonly number: number;
    readonly name: string;
    readonly slug: string;
    readonly platform: string | null;
    readonly publicKey: string;
    readonly enabled: boolean;
    readonly system: boolean;
    readonly retentionDays: number;
    readonly deployProjectId: string | null;
    readonly orgId: string | null;
    /** Unresolved issues, which is the only number the list needs. */
    readonly openIssues: number;
    readonly lastSeen: string | null;
    readonly rules: ReporterSettings;
    readonly refused: RefusalSummary;
}

/** A key is 32 hex characters: long enough that guessing one is not a strategy,
 *  short enough to read out of a configuration file. */
function mintKey(): string {
    return randomBytes(16).toString("hex");
}

/**
 * The number that goes in the DSN.
 *
 * Drawn at random rather than counted up. A sequence would say how many projects
 * an instance has and make the next one guessable, and a DSN is a string that
 * ends up in build logs and configuration repositories - the number in it should
 * name a project and imply nothing else. The range stops short of a 32-bit
 * integer because the column is one, and starts high enough that every number is
 * the same length, so no DSN looks like a different kind of DSN.
 */
function mintNumber(): number {
    return randomInt(100_000_000, 2_100_000_000);
}

/** A JSON string array as it comes out of the database, bounded and with the
 *  empty entries dropped. Anything that is not an array of strings reads as no
 *  rules at all, which for an allow list is the safe direction only because a
 *  policy of "listed" refuses an empty one outright. */
function readList(value: string | null | undefined, max: number): string[] {
    try {
        const parsed = JSON.parse(value ?? "[]");
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter(Boolean)
            .slice(0, max);
    } catch {
        return [];
    }
}

/** How many rules one project may carry. Every one of them is walked on every
 *  report, so the ceiling is what stops a list being a way to make an ingest
 *  expensive. */
const MAX_RULES = 50;

function rulesOf(row: {
    reporters: string;
    allowedCidrs: string;
    allowedUserAgents: string;
    deniedUserAgents: string;
    requireSecret: boolean;
    secretHash: string | null;
    secretTail: string | null;
}): ReporterSettings {
    return {
        reporters: core.readReporters(row.reporters),
        allowedCidrs: readList(row.allowedCidrs, MAX_RULES),
        allowedUserAgents: readList(row.allowedUserAgents, MAX_RULES),
        deniedUserAgents: readList(row.deniedUserAgents, MAX_RULES),
        requireSecret: row.requireSecret,
        hasSecret: row.secretHash !== null,
        secretTail: row.secretTail
    };
}

/** The two values a key is stored as: what it is compared against, and the tail
 *  that lets somebody tell which key this is without holding it. */
function sealSecret(secret: string): { secretHash: string; secretTail: string } {
    return {
        secretHash: createHash("sha256").update(secret).digest("hex"),
        secretTail: secret.slice(-4)
    };
}

/** Compared byte by byte in constant time. Two hex digests are always the same
 *  length, so this never falls back to the early return. */
function sameDigest(a: string, b: string): boolean {
    const left = Buffer.from(a, "utf8");
    const right = Buffer.from(b, "utf8");
    return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The address a client reports to.
 *
 * Sentry builds its endpoint from the DSN as `<origin><path>/api/<id>/envelope/`,
 * so the path here is what puts the ingest route under `/api/telemetry` instead
 * of at the root of the API namespace, where a bare `<id>` segment would sit in
 * front of every other route.
 */
export function dsnFor(project: { number: number; publicKey: string }, origin: string): string {
    const base = origin.replace(/\/+$/, "");
    return `${base.replace("://", `://${project.publicKey}@`)}/api/telemetry/${project.number}`;
}

/** Which projects this account may read. An instance administrator sees them
 *  all, which is what makes Polaris' own project reachable at all. */
export async function listProjects(
    actor: TelemetryActor,
    orgId: string | null
): Promise<ProjectSummary[]> {
    const rows = await prisma.telemetryProject.findMany({
        where: actor.isAdmin ? { orgId } : { ownerId: actor.id, orgId },
        orderBy: [{ system: "desc" }, { name: "asc" }],
        select: {
            id: true,
            number: true,
            name: true,
            slug: true,
            platform: true,
            publicKey: true,
            enabled: true,
            system: true,
            retentionDays: true,
            deployProjectId: true,
            orgId: true,
            reporters: true,
            allowedCidrs: true,
            allowedUserAgents: true,
            deniedUserAgents: true,
            requireSecret: true,
            secretHash: true,
            secretTail: true,
            refusedCount: true,
            refusedAt: true,
            refusedIp: true,
            refusedAgent: true,
            refusedReason: true,
            issues: {
                where: { status: "unresolved" },
                select: { lastSeen: true },
                orderBy: { lastSeen: "desc" }
            }
        }
    });
    return rows.map((row) => ({
        id: row.id,
        number: row.number,
        name: row.name,
        slug: row.slug,
        platform: row.platform,
        publicKey: row.publicKey,
        enabled: row.enabled,
        system: row.system,
        retentionDays: row.retentionDays,
        deployProjectId: row.deployProjectId,
        orgId: row.orgId,
        openIssues: row.issues.length,
        lastSeen: row.issues[0]?.lastSeen.toISOString() ?? null,
        rules: rulesOf(row),
        refused: {
            count: row.refusedCount,
            at: row.refusedAt?.toISOString() ?? null,
            ip: row.refusedIp,
            agent: row.refusedAgent,
            reason: (row.refusedReason as core.IngestRefusal) ?? null
        }
    }));
}

/**
 * Make a project.
 *
 * The number is drawn at random and a collision is retried rather than
 * serialized: with two billion of them and a handful of projects in the life of
 * an instance, a lock held across a create would be a lock held for something
 * that will not happen.
 */
export async function createProject(input: {
    ownerId: string;
    orgId?: string | null;
    name: string;
    slug: string;
    deployProjectId?: string | null;
    system?: boolean;
}): Promise<{ id: string; number: number; publicKey: string }> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            return await prisma.telemetryProject.create({
                data: {
                    ownerId: input.ownerId,
                    orgId: input.orgId ?? null,
                    deployProjectId: input.deployProjectId ?? null,
                    name: input.name,
                    slug: input.slug,
                    number: mintNumber(),
                    publicKey: mintKey(),
                    system: input.system === true
                },
                select: { id: true, number: true, publicKey: true }
            });
        } catch (error) {
            // Either the number or the key was already taken. Both are drawn
            // fresh on the next pass.
            if (attempt === 4) throw error;
        }
    }
    throw new Error("could not allocate a telemetry project number");
}

/**
 * Polaris' own project, made the first time anything asks for it.
 *
 * It belongs to the oldest account on the instance, which is the one that
 * installed it - a project has to belong to somebody, and inventing an owner
 * would mean a row nobody can see. Every instance administrator can read it
 * regardless, which is how it is actually reached.
 */
export async function systemProject(): Promise<{ id: string; platform: string | null } | null> {
    const existing = await prisma.telemetryProject.findFirst({
        where: { system: true },
        select: { id: true, platform: true }
    });
    if (existing) return existing;

    const owner = await prisma.user.findFirst({
        orderBy: { createdAt: "asc" },
        select: { id: true }
    });
    // Before anybody has signed up there is nothing to own it, and nothing to
    // read it either. The next crash after the first account exists opens it.
    if (!owner) return null;

    try {
        const made = await createProject({
            ownerId: owner.id,
            name: "Polaris",
            slug: SYSTEM_SLUG,
            system: true
        });
        return { id: made.id, platform: null };
    } catch {
        // Two crashes at once on a fresh install. Whoever lost takes the row the
        // winner wrote.
        return prisma.telemetryProject.findFirst({
            where: { system: true },
            select: { id: true, platform: true }
        });
    }
}

/** A project, as the ingest needs it: who it is, and what it will admit. */
export interface IngestProject {
    readonly id: string;
    readonly platform: string | null;
    readonly rules: core.ReporterRules;
    /** Present only when the project asks for a key. */
    readonly secretHash: string | null;
}

/**
 * The project a DSN names, if the key that came with it is that project's.
 *
 * The number says which project and the key says the request is allowed to write
 * into it. Neither is a secret and neither is treated as one; what this refuses
 * is a request that names one project with another's key, which is the whole of
 * what a public key can be asked to do. The comparison is constant-time anyway -
 * it costs nothing, and "public" is a statement about how a value is distributed
 * rather than a licence to leak it a byte at a time.
 *
 * What comes back with it is the rules, so admission is decided from one read
 * rather than two.
 */
export async function projectForIngest(number: number, publicKey: string): Promise<IngestProject | null> {
    const project = await prisma.telemetryProject.findUnique({
        where: { number },
        select: {
            id: true,
            publicKey: true,
            enabled: true,
            platform: true,
            reporters: true,
            allowedCidrs: true,
            allowedUserAgents: true,
            deniedUserAgents: true,
            requireSecret: true,
            secretHash: true,
            secretTail: true
        }
    });
    if (!project || !project.enabled || !sameDigest(project.publicKey, publicKey)) return null;
    const rules = rulesOf(project);
    return {
        id: project.id,
        platform: project.platform,
        // A project that asks for a key and has none would refuse everything for
        // a reason nobody set: the switch means nothing until a key exists.
        rules: { ...rules, requireSecret: rules.requireSecret && rules.hasSecret },
        secretHash: project.secretHash
    };
}

/** Whether the key a report carried is this project's. */
export function secretAccepted(project: IngestProject, presented: string | null): boolean {
    if (!project.secretHash || !presented) return false;
    return sameDigest(project.secretHash, createHash("sha256").update(presented).digest("hex"));
}

/**
 * Write down that a report was turned away.
 *
 * A count and the last one rather than a log. What somebody needs from this
 * screen is "something is being refused, from there, for that reason" - which is
 * one row - and a table of every rejected packet is a table an application in a
 * crash loop fills by itself.
 *
 * Never throws: this runs on the path a refused request already took, and a
 * failure to record it is not worth a second one.
 */
export async function recordRefusal(
    projectId: string,
    refusal: { reason: core.IngestRefusal; ip: string | null; userAgent: string | null }
): Promise<void> {
    try {
        await prisma.telemetryProject.update({
            where: { id: projectId },
            data: {
                refusedCount: { increment: 1 },
                refusedAt: new Date(),
                refusedIp: refusal.ip?.slice(0, 60) ?? null,
                refusedAgent: refusal.userAgent?.slice(0, 200) ?? null,
                refusedReason: refusal.reason
            }
        });
    } catch {
        // The report is already refused. Failing to note it changes nothing.
    }
}

/** Forget what was refused, once somebody has read it and acted. */
export async function clearRefusals(projectId: string): Promise<void> {
    await prisma.telemetryProject.update({
        where: { id: projectId },
        data: { refusedCount: 0, refusedAt: null, refusedIp: null, refusedAgent: null, refusedReason: null }
    });
}

/**
 * Change who may report.
 *
 * The lists are stored as they were given, trimmed and bounded; whether a rule is
 * a usable address or a usable pattern is decided before this, where there is a
 * person to tell.
 */
export async function setReporterRules(
    projectId: string,
    input: {
        reporters: core.TelemetryReporters;
        allowedCidrs: readonly string[];
        allowedUserAgents: readonly string[];
        deniedUserAgents: readonly string[];
        requireSecret: boolean;
    }
): Promise<void> {
    await prisma.telemetryProject.update({
        where: { id: projectId },
        data: {
            reporters: input.reporters,
            allowedCidrs: JSON.stringify(input.allowedCidrs.slice(0, MAX_RULES)),
            allowedUserAgents: JSON.stringify(input.allowedUserAgents.slice(0, MAX_RULES)),
            deniedUserAgents: JSON.stringify(input.deniedUserAgents.slice(0, MAX_RULES)),
            requireSecret: input.requireSecret
        }
    });
}

/**
 * A key for a project that wants one, returned once.
 *
 * Longer than the public key and not hex, so the two cannot be mistaken for each
 * other in a configuration file. Stored as a digest: a database dump yields
 * nothing that can be presented, and there is no second place to read it from -
 * somebody who loses it mints another.
 */
export async function mintSecret(projectId: string): Promise<string> {
    const secret = `plt_${randomBytes(24).toString("base64url")}`;
    await prisma.telemetryProject.update({
        where: { id: projectId },
        data: { ...sealSecret(secret), requireSecret: true }
    });
    return secret;
}

/** Stop asking for a key, and forget the one there was. Turning the switch off
 *  without this would leave a value nobody can see still standing. */
export async function clearSecret(projectId: string): Promise<void> {
    await prisma.telemetryProject.update({
        where: { id: projectId },
        data: { requireSecret: false, secretHash: null, secretTail: null }
    });
}

/** A new key for a project whose old one got out. The old one stops working the
 *  moment this returns, which is the point. */
export async function rotateKey(projectId: string): Promise<string> {
    const key = mintKey();
    await prisma.telemetryProject.update({ where: { id: projectId }, data: { publicKey: key } });
    return key;
}

/**
 * The project a deployed application reports into, made on first need.
 *
 * One per deploy project rather than per service: which service and which
 * environment an event came from travels on the event, which is how every client
 * already sends it and how anybody who has used Sentry expects to filter.
 */
export async function projectForDeploy(deploy: {
    id: string;
    name: string;
    slug: string;
    ownerId: string;
    orgId: string | null;
}): Promise<{ id: string; number: number; publicKey: string }> {
    const existing = await prisma.telemetryProject.findFirst({
        where: { deployProjectId: deploy.id },
        select: { id: true, number: true, publicKey: true }
    });
    if (existing) return existing;
    return createProject({
        ownerId: deploy.ownerId,
        orgId: deploy.orgId,
        deployProjectId: deploy.id,
        name: deploy.name,
        slug: deploy.slug
    });
}

/** Refused when the project is not this account's to read. */
export class TelemetryAccessError extends Error {
    constructor(message = "You do not have access to that project") {
        super(message);
        this.name = "TelemetryAccessError";
    }
}

/**
 * The project, once this account has been allowed to open it.
 *
 * Ownership, plus every instance administrator - which is how Polaris' own
 * project is reachable at all, since it belongs to whoever installed the box and
 * the failures in it are the operator's business rather than that person's.
 */
export async function requireProject(
    actor: TelemetryActor,
    projectId: string
): Promise<{ id: string; name: string; number: number; publicKey: string; system: boolean; retentionDays: number; enabled: boolean }> {
    const project = await prisma.telemetryProject.findUnique({
        where: { id: projectId },
        select: {
            id: true,
            ownerId: true,
            name: true,
            number: true,
            publicKey: true,
            system: true,
            retentionDays: true,
            enabled: true
        }
    });
    if (!project) throw new TelemetryAccessError("That project no longer exists");
    if (!actor.isAdmin && project.ownerId !== actor.id) throw new TelemetryAccessError();
    const { ownerId, ...rest } = project;
    void ownerId;
    return rest;
}

/** What a project keeps, and whether it is listening at all. */
export async function updateProject(
    projectId: string,
    input: { name?: string; enabled?: boolean; retentionDays?: number }
): Promise<void> {
    await prisma.telemetryProject.update({
        where: { id: projectId },
        data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            ...(input.retentionDays !== undefined ? { retentionDays: input.retentionDays } : {})
        }
    });
}

/** Delete a project and everything it recorded. Polaris' own is refused: the
 *  dashboard reports into it, and a missing row would mean losing the one
 *  failure nobody else is watching for. */
export async function deleteProject(projectId: string): Promise<boolean> {
    const project = await prisma.telemetryProject.findUnique({
        where: { id: projectId },
        select: { system: true }
    });
    if (!project || project.system) return false;
    await prisma.telemetryProject.delete({ where: { id: projectId } });
    return true;
}
