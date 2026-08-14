/**
 * Organizations over the API.
 *
 * Read-mostly on purpose. A client can see the organizations it is in, their
 * collections and their members, and an administrator can arrange collections -
 * but creating an organization vault and confirming a member both need a browser
 * holding an unlocked vault to wrap a key, so both live in the Polaris screens
 * rather than here. An endpoint that pretended to do them would have to invent
 * key material, which is the one thing this whole design exists to prevent.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import * as orgs from "@/lib/vault/orgs";
import { vaultError } from "@/lib/vault/auth";
import { collectionsFor } from "@/lib/vault/sync";
import { readJsonBody, requirePrincipal, type VaultContext } from "@/lib/vault/api/router";

function list(data: unknown[]): Response {
    return Response.json({ object: "list", continuationToken: null, data });
}

/** Every collection this account reaches, across every organization. */
export async function listCollections(context: VaultContext): Promise<Response> {
    return list(await collectionsFor(requirePrincipal(context).userId));
}

/** The standing an administering request needs, or a refusal. */
async function administering(
    context: VaultContext
): Promise<{ ok: true; orgId: string } | { ok: false; response: Response }> {
    const principal = requirePrincipal(context);
    const orgId = context.params.orgId ?? "";
    const standing = await orgs.standingIn(principal.userId, orgId);
    if (!standing?.confirmed) return { ok: false, response: vaultError("Not found", 404) };
    if (!orgs.mayAdminister(standing)) {
        return { ok: false, response: vaultError("You cannot change this organization.", 403) };
    }
    return { ok: true, orgId };
}

export async function getOrganization(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const orgId = context.params.orgId ?? "";
    const standing = await orgs.standingIn(principal.userId, orgId);
    if (!standing) return vaultError("Not found", 404);
    const row = await prisma.vaultOrganization.findUnique({
        where: { id: orgId },
        select: { id: true, organization: { select: { name: true, slug: true } } }
    });
    if (!row) return vaultError("Not found", 404);
    return Response.json({
        object: "organization",
        id: row.id,
        name: row.organization.name,
        identifier: row.organization.slug,
        selfHost: true,
        useTotp: true,
        usePolicies: true,
        useGroups: true,
        useEvents: true,
        useDirectory: false,
        useSso: false,
        planType: 2,
        seats: null,
        maxCollections: null,
        maxStorageGb: null
    });
}

/** The organization's public key, so a client can wrap something to it. */
export async function getOrganizationKeys(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const orgId = context.params.orgId ?? "";
    if (!(await orgs.standingIn(principal.userId, orgId))) return vaultError("Not found", 404);
    const row = await prisma.vaultOrganization.findUnique({
        where: { id: orgId },
        select: { publicKey: true, privateKey: true }
    });
    if (!row) return vaultError("Not found", 404);
    return Response.json({
        object: "organizationKeys",
        publicKey: row.publicKey,
        privateKey: row.privateKey
    });
}

export async function listMembers(context: VaultContext): Promise<Response> {
    const guard = await administering(context);
    if (!guard.ok) return guard.response;
    return list(await orgs.listMembers(guard.orgId));
}

export async function listOrgCollections(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const orgId = context.params.orgId ?? "";
    const standing = await orgs.standingIn(principal.userId, orgId);
    if (!standing?.confirmed) return vaultError("Not found", 404);
    // An administrator sees every collection; everybody else sees the ones they
    // were put in, which is what the sync already answers.
    if (orgs.mayAdminister(standing)) return list(await orgs.listOrgCollections(orgId));
    const mine = await collectionsFor(principal.userId);
    return list(mine.filter((collection) => collection.organizationId === orgId));
}

export async function createCollection(context: VaultContext): Promise<Response> {
    const guard = await administering(context);
    if (!guard.ok) return guard.response;
    const parsed = core.collectionSchema.safeParse(await readJsonBody(context.request));
    if (!parsed.success) return vaultError("A collection name must be encrypted.", 400);
    const collection = await orgs.createCollection(
        guard.orgId,
        parsed.data.name,
        parsed.data.externalId
    );
    if (!collection) return vaultError("A collection name must be encrypted.", 400);
    for (const member of parsed.data.users ?? []) {
        await orgs.setCollectionAccess(String(collection.id), member.id, {
            readOnly: member.readOnly,
            hidePasswords: member.hidePasswords
        });
    }
    return Response.json(collection);
}

export async function updateCollection(context: VaultContext): Promise<Response> {
    const guard = await administering(context);
    if (!guard.ok) return guard.response;
    const parsed = core.collectionSchema.safeParse(await readJsonBody(context.request));
    if (!parsed.success) return vaultError("A collection name must be encrypted.", 400);
    const collectionId = context.params.id ?? "";
    const collection = await orgs.updateCollection(guard.orgId, collectionId, parsed.data.name);
    if (!collection) return vaultError("Not found", 404);
    if (parsed.data.users) {
        await prisma.vaultCollectionAccess.deleteMany({ where: { collectionId } });
        for (const member of parsed.data.users) {
            await orgs.setCollectionAccess(collectionId, member.id, {
                readOnly: member.readOnly,
                hidePasswords: member.hidePasswords
            });
        }
    }
    return Response.json(collection);
}

export async function deleteCollection(context: VaultContext): Promise<Response> {
    const guard = await administering(context);
    if (!guard.ok) return guard.response;
    if (!(await orgs.deleteCollection(guard.orgId, context.params.id ?? ""))) {
        return vaultError("Not found", 404);
    }
    return new Response(null, { status: 200 });
}
