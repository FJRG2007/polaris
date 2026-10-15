/**
 * Container registry logins.
 *
 * A login is personal (its owner's alone) or held by an organization, where
 * anybody on the roster deploys with it and whoever holds the organization's
 * `deploy.manage` adds, edits and removes it - the organization's own roles,
 * not a parallel set. The password is envelope-encrypted at rest (the same
 * AES-256-GCM master key that protects other secrets), and nothing in this file
 * returns it to a caller other than the deploy that pulls with it.
 *
 * A deploy uses the registry its service picked when the project may use it,
 * and otherwise the one whose host matches the image: the organization's first,
 * then the project owner's own, which is how every install before this worked.
 */

import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";
import { encryptSecret, decryptSecret, CredentialDecryptError } from "@polaris/storage";
import { orgCan, resolveOrgAccess, type OrgActor } from "@/lib/orgs/org-service";
import { configuredRequest } from "@/lib/safe-fetch";
import {
    normalizeRegistryForm,
    normalizeRegistryHost,
    registryCreateSchema,
    registryUpdateSchema,
    REGISTRY_KINDS,
    type RegistryFormValues,
    type RegistryKind
} from "@/lib/registries/registry-form";

/** A refusal whose message is a key of the `deployRegistries` namespace. */
export class RegistryRefusal extends Error {
    constructor(readonly key: string) {
        super(key);
        this.name = "RegistryRefusal";
    }
}

export interface RegistryView {
    id: string;
    name: string;
    kind: RegistryKind;
    registry: string;
    username: string;
    orgId: string | null;
    updatedAt: string;
    lastTestedAt: string | null;
    lastTestOk: boolean | null;
}

/** Kept for the screens that read the old shape. */
export type RegistryCredentialView = RegistryView;

const VIEW_SELECT = {
    id: true,
    name: true,
    kind: true,
    registry: true,
    username: true,
    orgId: true,
    updatedAt: true,
    lastTestedAt: true,
    lastTestOk: true
} as const;

type ViewRow = {
    id: string;
    name: string;
    kind: string;
    registry: string;
    username: string;
    orgId: string | null;
    updatedAt: Date;
    lastTestedAt: Date | null;
    lastTestOk: boolean | null;
};

function toView(row: ViewRow): RegistryView {
    return {
        id: row.id,
        name: row.name || row.registry,
        kind: (REGISTRY_KINDS as readonly string[]).includes(row.kind)
            ? (row.kind as RegistryKind)
            : "generic",
        registry: row.registry,
        username: row.username,
        orgId: row.orgId,
        updatedAt: row.updatedAt.toISOString(),
        lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
        lastTestOk: row.lastTestOk
    };
}

/** Where a shelf's logins live: the person's own, or the organization's. */
function shelfWhere(actorId: string, orgId: string | null) {
    return orgId ? { orgId } : { ownerId: actorId, orgId: null };
}

export interface RegistryShelf {
    registries: RegistryView[];
    /** Whether this person may add, edit and remove logins on this shelf. */
    canManage: boolean;
}

/**
 * The logins on one shelf. Anybody on an organization's roster sees its logins
 * (names and users, never a secret); only `deploy.manage` changes them.
 */
export async function listRegistries(
    actor: OrgActor,
    orgId: string | null
): Promise<RegistryShelf> {
    let canManage = true;
    if (orgId) {
        const access = await resolveOrgAccess(actor, orgId);
        if (!orgCan(access, "org.read")) throw new RegistryRefusal("errors.notFound");
        canManage = orgCan(access, "deploy.manage");
    }
    const rows = await prisma.registryCredential.findMany({
        where: shelfWhere(actor.id, orgId),
        orderBy: [{ name: "asc" }, { registry: "asc" }],
        select: VIEW_SELECT,
        take: 500
    });
    return { registries: rows.map(toView), canManage };
}

/** Refuses unless the actor may change logins on this shelf. */
async function requireManage(actor: OrgActor, orgId: string | null): Promise<void> {
    if (!orgId) return;
    const access = await resolveOrgAccess(actor, orgId);
    if (!orgCan(access, "org.read")) throw new RegistryRefusal("errors.notFound");
    if (!orgCan(access, "deploy.manage")) throw new RegistryRefusal("errors.cannotManage");
}

/** A stored login the actor may change, or a refusal. A personal login that is
 *  somebody else's is "not found", never "not yours". */
async function manageableRow(actor: OrgActor, id: string) {
    const row = await prisma.registryCredential.findUnique({ where: { id } });
    if (!row) throw new RegistryRefusal("errors.notFound");
    if (!row.orgId) {
        if (row.ownerId !== actor.id) throw new RegistryRefusal("errors.notFound");
        return row;
    }
    await requireManage(actor, row.orgId);
    return row;
}

function sealed(password: string) {
    const blob = encryptSecret(password, loadEnv().POLARIS_MASTER_KEY);
    return {
        encryptedPassword: blob.ciphertext,
        passwordNonce: blob.nonce,
        passwordKeyId: blob.keyId
    };
}

function opened(row: {
    encryptedPassword: Uint8Array;
    passwordNonce: Uint8Array;
    passwordKeyId: string;
}): string | null {
    try {
        return decryptSecret(
            {
                ciphertext: Buffer.from(row.encryptedPassword),
                nonce: Buffer.from(row.passwordNonce),
                keyId: row.passwordKeyId
            },
            loadEnv().POLARIS_MASTER_KEY
        );
    } catch (caught) {
        if (caught instanceof CredentialDecryptError) return null;
        throw caught;
    }
}

function parsedOrRefused(values: RegistryFormValues, editing: boolean) {
    const schema = editing ? registryUpdateSchema : registryCreateSchema;
    const parsed = schema.safeParse(normalizeRegistryForm(values));
    if (!parsed.success)
        throw new RegistryRefusal(parsed.error.issues[0]?.message ?? "errors.invalid");
    return parsed.data;
}

/** Adds a login to the actor's own shelf, or an organization's. */
export async function createRegistry(
    actor: OrgActor,
    orgId: string | null,
    values: RegistryFormValues
): Promise<RegistryView> {
    await requireManage(actor, orgId);
    const input = parsedOrRefused(values, false);
    const row = await prisma.registryCredential.create({
        data: {
            ownerId: actor.id,
            orgId,
            name: input.name,
            kind: input.kind,
            registry: input.host,
            username: input.username,
            ...sealed(input.password)
        },
        select: VIEW_SELECT
    });
    return toView(row);
}

/** Edits a login. An empty password keeps the stored one; a changed host or
 *  user forgets the last test, since it no longer describes this login. */
export async function updateRegistry(
    actor: OrgActor,
    id: string,
    values: RegistryFormValues
): Promise<RegistryView> {
    const current = await manageableRow(actor, id);
    const input = parsedOrRefused(values, true);
    const moved = current.registry !== input.host || current.username !== input.username;
    if (moved && !input.password) throw new RegistryRefusal("form.secretRequiredOnMove");
    const row = await prisma.registryCredential.update({
        where: { id },
        data: {
            name: input.name,
            kind: input.kind,
            registry: input.host,
            username: input.username,
            ...(input.password ? sealed(input.password) : {}),
            ...(moved || input.password ? { lastTestedAt: null, lastTestOk: null } : {})
        },
        select: VIEW_SELECT
    });
    return toView(row);
}

/** Removes a login. Services that picked it fall back to matching by host. */
export async function deleteRegistry(
    actor: OrgActor,
    id: string
): Promise<{ orgId: string | null; registry: string }> {
    const row = await manageableRow(actor, id);
    await prisma.registryCredential.delete({ where: { id } });
    return { orgId: row.orgId, registry: row.registry };
}

/** Normalize a registry host. Empty maps to Docker Hub ("docker.io"). */
export function normalizeRegistry(input: string): string {
    return normalizeRegistryHost(input) || "docker.io";
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

export type RegistryTestResult = "ok" | "denied" | "unreachable" | "notRegistry";

/** Where a host's registry API answers. Docker Hub's is not on docker.io. */
function apiHost(host: string): string {
    return host === "docker.io" ? "registry-1.docker.io" : host;
}

/** `Bearer realm="...",service="..."`, as a registry challenges. */
export function parseChallenge(
    header: string
): { scheme: string; params: Record<string, string> } | null {
    const match = /^\s*(\w+)\s*(.*)$/.exec(header);
    if (!match) return null;
    const params: Record<string, string> = {};
    for (const part of match[2]!.matchAll(/(\w+)="([^"]*)"/g))
        params[part[1]!.toLowerCase()] = part[2]!;
    return { scheme: match[1]!.toLowerCase(), params };
}

/**
 * Signs in the way `docker login` does: ask the registry's API root, follow its
 * challenge to the token service with the login as basic auth, and read the
 * answer. No image is touched and nothing is kept.
 */
export async function probeRegistryLogin(
    host: string,
    username: string,
    password: string,
    options: { allowPrivate: boolean }
): Promise<RegistryTestResult> {
    const basic = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    let root: Response;
    try {
        root = await configuredRequest(
            `https://${apiHost(host)}/v2/`,
            { method: "GET", timeoutMs: 10_000 },
            options
        );
    } catch {
        return "unreachable";
    }
    await root.body?.cancel().catch(() => undefined);
    if (root.status === 200) {
        // Open to anybody: there is nothing to sign in to, so nothing a login
        // could get wrong.
        return "ok";
    }
    if (root.status !== 401) return "notRegistry";
    const challenge = parseChallenge(root.headers.get("www-authenticate") ?? "");
    if (!challenge) return "notRegistry";
    let answer: Response;
    try {
        if (challenge.scheme === "basic") {
            answer = await configuredRequest(
                `https://${apiHost(host)}/v2/`,
                { method: "GET", headers: { authorization: basic }, timeoutMs: 10_000 },
                options
            );
        } else if (challenge.scheme === "bearer" && challenge.params.realm) {
            const realm = new URL(challenge.params.realm);
            if (realm.protocol !== "https:") return "notRegistry";
            if (challenge.params.service)
                realm.searchParams.set("service", challenge.params.service);
            realm.searchParams.set("account", username);
            answer = await configuredRequest(
                realm.toString(),
                { method: "GET", headers: { authorization: basic }, timeoutMs: 10_000 },
                options
            );
        } else {
            return "notRegistry";
        }
    } catch {
        return "unreachable";
    }
    await answer.body?.cancel().catch(() => undefined);
    if (answer.status === 200) return "ok";
    if (answer.status === 401 || answer.status === 403) return "denied";
    return "notRegistry";
}

/**
 * Tests a stored login (and records the answer) or the values in an unsaved
 * form. An unsaved form editing a stored login may leave the secret empty to
 * test with the stored one. Private addresses are only probed for an instance
 * administrator: for anybody else it is a scan of the network Polaris sits on.
 */
export async function testRegistry(
    actor: OrgActor,
    input: { id?: string; orgId: string | null; values?: RegistryFormValues }
): Promise<RegistryTestResult> {
    let host: string;
    let username: string;
    let password: string | null;
    const stored = input.id ? await manageableRow(actor, input.id) : null;
    if (input.values) {
        if (!stored) await requireManage(actor, input.orgId);
        const values = parsedOrRefused(input.values, stored !== null);
        const moved =
            stored !== null &&
            (stored.registry !== values.host || stored.username !== values.username);
        if (moved && !values.password) throw new RegistryRefusal("form.secretRequiredOnMove");
        host = values.host;
        username = values.username;
        password = values.password || (stored ? opened(stored) : null);
    } else if (stored) {
        host = stored.registry;
        username = stored.username;
        password = opened(stored);
    } else {
        throw new RegistryRefusal("errors.invalid");
    }
    if (password === null) throw new RegistryRefusal("errors.unreadable");
    const result = await probeRegistryLogin(host, username, password, {
        allowPrivate: actor.isAdmin
    });
    const unchanged =
        stored &&
        (!input.values ||
            (host === stored.registry && username === stored.username && !input.values.password));
    if (stored && unchanged) {
        await prisma.registryCredential.update({
            where: { id: stored.id },
            data: { lastTestedAt: new Date(), lastTestOk: result === "ok" }
        });
    }
    return result;
}

// ---------------------------------------------------------------------------
// Deploys
// ---------------------------------------------------------------------------

/** The logins a project's services may pick: an organization's project uses
 *  the organization's, a personal project its owner's own. */
function projectWhere(project: { ownerId: string; orgId: string | null }) {
    return project.orgId ? { orgId: project.orgId } : { ownerId: project.ownerId, orgId: null };
}

/** The registry a service picked, read from its stored source. */
export function pickedRegistryId(sourceConfig: string): string | null {
    try {
        const source = JSON.parse(sourceConfig) as { registryId?: unknown };
        return typeof source.registryId === "string" && source.registryId
            ? source.registryId
            : null;
    } catch {
        return null;
    }
}

async function applicationProject(applicationId: string) {
    return prisma.application.findUnique({
        where: { id: applicationId },
        select: {
            sourceConfig: true,
            environment: { select: { project: { select: { ownerId: true, orgId: true } } } }
        }
    });
}

export interface ServiceRegistryChoice {
    registries: RegistryView[];
    selected: string | null;
}

/** What a service may pick from, and what it has picked. The caller has
 *  already checked the reader may see the service. */
export async function registriesForApplication(
    applicationId: string
): Promise<ServiceRegistryChoice> {
    const app = await applicationProject(applicationId);
    if (!app) throw new RegistryRefusal("errors.notFound");
    const rows = await prisma.registryCredential.findMany({
        where: projectWhere(app.environment.project),
        orderBy: [{ name: "asc" }, { registry: "asc" }],
        select: VIEW_SELECT,
        take: 500
    });
    const selected = pickedRegistryId(app.sourceConfig);
    return {
        registries: rows.map(toView),
        selected: selected && rows.some((row) => row.id === selected) ? selected : null
    };
}

/** Picks (or clears, with null) the registry a service pulls its image with.
 *  Only a login the project may use is accepted. */
export async function setApplicationRegistry(
    applicationId: string,
    registryId: string | null
): Promise<void> {
    const app = await applicationProject(applicationId);
    if (!app) throw new RegistryRefusal("errors.notFound");
    if (registryId) {
        const usable = await prisma.registryCredential.findFirst({
            where: { id: registryId, ...projectWhere(app.environment.project) },
            select: { id: true }
        });
        if (!usable) throw new RegistryRefusal("errors.notUsable");
    }
    let source: Record<string, unknown> = {};
    try {
        source = JSON.parse(app.sourceConfig) as Record<string, unknown>;
    } catch {
        source = {};
    }
    if (registryId) source.registryId = registryId;
    else delete source.registryId;
    await prisma.application.update({
        where: { id: applicationId },
        data: { sourceConfig: JSON.stringify(source) }
    });
}

/** The registry host an image reference pulls from ("docker.io" when implicit). */
export function registryHostOfImage(image: string): string {
    const first = image.split("/")[0] ?? "";
    // A registry host has a dot, a colon (port), or is localhost; otherwise the
    // image is a Docker Hub short name (e.g. "nginx:latest").
    if (!image.includes("/")) return "docker.io";
    if (first.includes(".") || first.includes(":") || first === "localhost") {
        return normalizeRegistry(first);
    }
    return "docker.io";
}

export interface RegistryLogin {
    /** Passed to `docker login`; empty targets Docker Hub. */
    registry: string;
    username: string;
    password: string;
    /** False when the service picked a login for a host the image is not on. */
    matchesImage: boolean;
}

/**
 * The login a deploy uses to pull an image, or null.
 *
 * The service's pick wins when the project may still use it. Otherwise the host
 * decides: the organization's logins for that host first, then the project
 * owner's own, which is the only place a login lived before organizations
 * held them. `ownerId` is the project owner, as every deploy has passed it.
 */
export async function resolveRegistryLogin(
    ownerId: string,
    image: string,
    applicationId?: string
): Promise<RegistryLogin | null> {
    const host = registryHostOfImage(image);
    const app = applicationId ? await applicationProject(applicationId) : null;
    const project = app?.environment.project ?? { ownerId, orgId: null };
    const candidates = [];
    const picked = app ? pickedRegistryId(app.sourceConfig) : null;
    if (picked) {
        const row = await prisma.registryCredential.findFirst({
            where: { id: picked, ...projectWhere(project) }
        });
        if (row) candidates.push(row);
    }
    if (project.orgId) {
        candidates.push(
            ...(await prisma.registryCredential.findMany({
                where: { orgId: project.orgId, registry: host },
                orderBy: { updatedAt: "desc" },
                take: 5
            }))
        );
    }
    candidates.push(
        ...(await prisma.registryCredential.findMany({
            where: { ownerId: project.ownerId, orgId: null, registry: host },
            orderBy: { updatedAt: "desc" },
            take: 5
        }))
    );
    for (const row of candidates) {
        const password = opened(row);
        if (password === null) continue;
        return {
            registry: row.registry === "docker.io" ? "" : row.registry,
            username: row.username,
            password,
            matchesImage: row.registry === host
        };
    }
    return null;
}
