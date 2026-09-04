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

import { prisma } from "@polaris/db";
import { randomBytes } from "node:crypto";

/** The slug and name Polaris' own project always has. */
const SYSTEM_SLUG = "polaris";

export interface TelemetryActor {
    readonly id: string;
    readonly isAdmin: boolean;
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
}

/** A key is 32 hex characters: long enough that guessing one is not a strategy,
 *  short enough to read out of a configuration file. */
function mintKey(): string {
    return randomBytes(16).toString("hex");
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
            issues: {
                where: { status: "unresolved" },
                select: { lastSeen: true },
                orderBy: { lastSeen: "desc" }
            }
        }
    });
    return rows.map((row) => ({
        ...row,
        openIssues: row.issues.length,
        lastSeen: row.issues[0]?.lastSeen.toISOString() ?? null
    }));
}

/**
 * Make a project.
 *
 * The number is allocated as one past the highest there is, and a collision
 * between two people creating one at the same moment is retried rather than
 * serialized: it is a handful of rows in the life of an instance, and a lock
 * held across a create would be a lock held for something that almost never
 * contends.
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
        const highest = await prisma.telemetryProject.aggregate({ _max: { number: true } });
        try {
            return await prisma.telemetryProject.create({
                data: {
                    ownerId: input.ownerId,
                    orgId: input.orgId ?? null,
                    deployProjectId: input.deployProjectId ?? null,
                    name: input.name,
                    slug: input.slug,
                    number: (highest._max.number ?? 0) + 1,
                    publicKey: mintKey(),
                    system: input.system === true
                },
                select: { id: true, number: true, publicKey: true }
            });
        } catch (error) {
            // Somebody else took the number between the read and the write.
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

/**
 * The project a DSN names, if the key that came with it is that project's.
 *
 * The number says which project and the key says the request is allowed to write
 * into it. Neither is a secret and neither is treated as one; what this refuses
 * is a request that names one project with another's key, which is the whole of
 * what a public key can be asked to do.
 */
export async function projectForIngest(
    number: number,
    publicKey: string
): Promise<{ id: string; platform: string | null } | null> {
    const project = await prisma.telemetryProject.findUnique({
        where: { number },
        select: { id: true, publicKey: true, enabled: true, platform: true }
    });
    if (!project || !project.enabled || project.publicKey !== publicKey) return null;
    return { id: project.id, platform: project.platform };
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
