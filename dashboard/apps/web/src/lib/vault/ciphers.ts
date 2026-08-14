/**
 * Vault items: reading them, writing them, and deciding who reaches which.
 *
 * The item's contents are one opaque JSON document, because that is what they
 * are - a bag of encrypted strings the server cannot read and has no reason to
 * index. What is NOT in the document is everything access depends on: who owns
 * it, which organization it belongs to, which collections it is in. Those are
 * columns, because they are the questions this file has to answer.
 *
 * The response shape is Bitwarden's `cipherDetails`. Clients read it field by
 * field, so the names and the nulls are part of the contract, not decoration.
 */

import { prisma } from "@polaris/db";
import type { CipherInput } from "@polaris/core";
import { bumpRevision } from "@/lib/vault/account";
import { ORG_USER_CONFIRMED } from "@polaris/core";
import { deleteVaultBlob } from "@/lib/vault/blobs";

/** The parts of an item that live inside the encrypted document. */
interface CipherDocument {
    name: string;
    notes?: string | null;
    fields?: unknown[] | null;
    passwordHistory?: unknown[] | null;
    login?: unknown;
    card?: unknown;
    identity?: unknown;
    secureNote?: unknown;
    sshKey?: unknown;
}

/** Everything about a stored item the response needs. */
type CipherRow = {
    id: string;
    userId: string | null;
    organizationId: string | null;
    folderId: string | null;
    type: number;
    data: string;
    reprompt: number;
    createdAt: Date;
    revisionDate: Date;
    deletedDate: Date | null;
    collections?: { collectionId: string }[];
    attachments?: {
        id: string;
        fileName: string;
        key: string | null;
        size: bigint;
    }[];
};

/** Pull the encrypted document out of an item's `data` column. */
function documentOf(row: { data: string }): CipherDocument {
    try {
        return JSON.parse(row.data) as CipherDocument;
    } catch {
        // A row whose document cannot be parsed is corrupt, not dangerous: it is
        // returned with an empty name so the client shows something it can delete
        // rather than failing its whole sync on one bad item.
        return { name: "" };
    }
}

/** The document to store for an item a client sent. */
function toDocument(input: CipherInput): string {
    return JSON.stringify({
        name: input.name,
        notes: input.notes ?? null,
        fields: input.fields ?? null,
        passwordHistory: input.passwordHistory ?? null,
        login: input.login ?? null,
        card: input.card ?? null,
        identity: input.identity ?? null,
        secureNote: input.secureNote ?? null,
        sshKey: input.sshKey ?? null
    } satisfies CipherDocument);
}

/** One item, in the shape a client expects to read. */
export function toCipherResponse(row: CipherRow, favorite: boolean): Record<string, unknown> {
    const document = documentOf(row);
    return {
        object: "cipherDetails",
        id: row.id,
        organizationId: row.organizationId,
        folderId: row.folderId,
        type: row.type,
        name: document.name,
        notes: document.notes ?? null,
        favorite,
        reprompt: row.reprompt,
        login: document.login ?? null,
        card: document.card ?? null,
        identity: document.identity ?? null,
        secureNote: document.secureNote ?? null,
        sshKey: document.sshKey ?? null,
        fields: document.fields ?? null,
        passwordHistory: document.passwordHistory ?? null,
        attachments:
            row.attachments?.map((attachment) => ({
                object: "attachment",
                id: attachment.id,
                fileName: attachment.fileName,
                key: attachment.key,
                size: attachment.size.toString(),
                sizeName: `${Math.max(1, Math.round(Number(attachment.size) / 1024))} KB`,
                url: `/vault/api/ciphers/${row.id}/attachment/${attachment.id}`
            })) ?? null,
        collectionIds: row.collections?.map((link) => link.collectionId) ?? [],
        // Self-hosted Polaris has no paid tier gating TOTP, and a client told
        // otherwise hides the field.
        organizationUseTotp: true,
        // Read-only collection membership is applied when the item is written,
        // not advertised per item; clients treat these as "may edit".
        edit: true,
        viewPassword: true,
        key: null,
        creationDate: row.createdAt.toISOString(),
        revisionDate: row.revisionDate.toISOString(),
        deletedDate: row.deletedDate ? row.deletedDate.toISOString() : null
    };
}

/** The organizations whose vault this account is a confirmed member of. */
async function confirmedMemberships(userId: string) {
    return prisma.vaultOrgUser.findMany({
        where: { userId, status: ORG_USER_CONFIRMED },
        select: { id: true, orgId: true, accessAll: true }
    });
}

/**
 * Which items this account may see.
 *
 * Three ways in, and they are genuinely different: your own, an organization you
 * reach everything in, and one where you reach only the collections you were put
 * in. Written as one `where` so every read goes through the same answer rather
 * than each call site remembering the third case.
 */
export async function reachableCipherFilter(userId: string) {
    const memberships = await confirmedMemberships(userId);
    const allAccess = memberships.filter((row) => row.accessAll).map((row) => row.orgId);
    const memberIds = memberships.map((row) => row.id);
    return {
        OR: [
            { userId },
            ...(allAccess.length > 0 ? [{ organizationId: { in: allAccess } }] : []),
            ...(memberIds.length > 0
                ? [
                      {
                          collections: {
                              some: { collection: { members: { some: { orgUserId: { in: memberIds } } } } }
                          }
                      }
                  ]
                : [])
        ]
    };
}

const CIPHER_SELECT = {
    id: true,
    userId: true,
    organizationId: true,
    folderId: true,
    type: true,
    data: true,
    reprompt: true,
    createdAt: true,
    revisionDate: true,
    deletedDate: true,
    collections: { select: { collectionId: true } },
    attachments: { select: { id: true, fileName: true, key: true, size: true } }
} as const;

/** Every item this account can see, trash included - clients draw the trash. */
export async function listCiphers(userId: string) {
    const [rows, favorites] = await Promise.all([
        prisma.vaultCipher.findMany({ where: await reachableCipherFilter(userId), select: CIPHER_SELECT }),
        prisma.vaultFavorite.findMany({ where: { userId }, select: { cipherId: true } })
    ]);
    const starred = new Set(favorites.map((row) => row.cipherId));
    return rows.map((row) => toCipherResponse(row, starred.has(row.id)));
}

/** One item this account can see, or null. */
export async function getCipher(userId: string, cipherId: string) {
    const filter = await reachableCipherFilter(userId);
    const row = await prisma.vaultCipher.findFirst({
        where: { AND: [{ id: cipherId }, filter] },
        select: CIPHER_SELECT
    });
    if (!row) return null;
    const favorite = await prisma.vaultFavorite.findUnique({
        where: { userId_cipherId: { userId, cipherId } },
        select: { userId: true }
    });
    return toCipherResponse(row, favorite !== null);
}

/** Whether this account may WRITE an item, which is narrower than seeing it. */
async function mayWrite(userId: string, cipherId: string): Promise<boolean> {
    const memberships = await confirmedMemberships(userId);
    const allAccess = memberships.filter((row) => row.accessAll).map((row) => row.orgId);
    const memberIds = memberships.map((row) => row.id);
    const row = await prisma.vaultCipher.findFirst({
        where: {
            id: cipherId,
            OR: [
                { userId },
                ...(allAccess.length > 0 ? [{ organizationId: { in: allAccess } }] : []),
                ...(memberIds.length > 0
                    ? [
                          {
                              collections: {
                                  some: {
                                      collection: {
                                          members: {
                                              some: { orgUserId: { in: memberIds }, readOnly: false }
                                          }
                                      }
                                  }
                              }
                          }
                      ]
                    : [])
            ]
        },
        select: { id: true }
    });
    return row !== null;
}

/**
 * The folder an item is filed under, kept to the caller's own.
 *
 * Folders are personal, so a client naming somebody else's is either confused or
 * probing: the item is theirs either way, and the id would only point at a row
 * neither side can draw it under. Null - "no folder" - is the honest answer.
 */
async function ownFolderId(
    userId: string,
    folderId: string | null | undefined
): Promise<string | null> {
    if (!folderId) return null;
    const row = await prisma.vaultFolder.findFirst({
        where: { id: folderId, userId },
        select: { id: true }
    });
    return row?.id ?? null;
}

/**
 * The collections of one organization this account may file an item into, or
 * null when it is not a confirmed member of that organization at all.
 *
 * Both halves matter and they are different questions. Membership decides
 * whether an item may be handed to the organization; the collections decide
 * where inside it the item lands, and a client naming a collection of some other
 * organization - or one it was never put in - has that collection dropped rather
 * than the item filed somewhere its owner cannot see.
 */
async function writableCollections(
    userId: string,
    organizationId: string,
    collectionIds: string[]
): Promise<string[] | null> {
    const membership = (await confirmedMemberships(userId)).find(
        (row) => row.orgId === organizationId
    );
    if (!membership) return null;
    if (collectionIds.length === 0) return [];
    const rows = await prisma.vaultCollection.findMany({
        where: {
            id: { in: collectionIds },
            orgId: organizationId,
            ...(membership.accessAll
                ? {}
                : { members: { some: { orgUserId: membership.id, readOnly: false } } })
        },
        select: { id: true }
    });
    return rows.map((row) => row.id);
}

/**
 * Create an item, personal or straight into an organization's collections.
 *
 * Null when the client asked for an organization it is not a confirmed member
 * of: being able to name an organization is not the same as belonging to it, and
 * this is the one write that would otherwise take the name on trust.
 */
export async function createCipher(
    userId: string,
    input: CipherInput,
    collectionIds: string[] = []
): Promise<Record<string, unknown> | null> {
    const organizationId = input.organizationId ?? null;
    let collections: string[] = [];
    if (organizationId) {
        const allowed = await writableCollections(userId, organizationId, collectionIds);
        if (allowed === null) return null;
        collections = allowed;
    }
    const row = await prisma.vaultCipher.create({
        data: {
            // An item belongs to a person or to an organization, never both: the
            // key it is encrypted under is one or the other.
            userId: organizationId ? null : userId,
            organizationId,
            folderId: await ownFolderId(userId, input.folderId),
            type: input.type,
            data: toDocument(input),
            reprompt: input.reprompt ?? 0,
            ...(collections.length > 0
                ? { collections: { create: collections.map((collectionId) => ({ collectionId })) } }
                : {})
        },
        select: CIPHER_SELECT
    });
    if (input.favorite) await setFavorite(userId, row.id, true);
    await bumpRevision(userId);
    return toCipherResponse(row, input.favorite === true);
}

/** Why a write was refused. */
export type CipherWriteResult =
    | { ok: true; cipher: Record<string, unknown> }
    | { ok: false; reason: "not_found" | "conflict" };

/**
 * Rewrite an item.
 *
 * A client that sends the revision it last saw gets a refusal rather than an
 * overwrite when somebody else has saved since - two people editing one shared
 * login should not silently end with one of them winning.
 */
export async function updateCipher(
    userId: string,
    cipherId: string,
    input: CipherInput
): Promise<CipherWriteResult> {
    if (!(await mayWrite(userId, cipherId))) return { ok: false, reason: "not_found" };
    if (input.lastKnownRevisionDate) {
        const current = await prisma.vaultCipher.findUnique({
            where: { id: cipherId },
            select: { revisionDate: true }
        });
        if (current && current.revisionDate.getTime() > input.lastKnownRevisionDate.getTime()) {
            return { ok: false, reason: "conflict" };
        }
    }
    const row = await prisma.vaultCipher.update({
        where: { id: cipherId },
        data: {
            folderId: await ownFolderId(userId, input.folderId),
            type: input.type,
            data: toDocument(input),
            reprompt: input.reprompt ?? 0,
            revisionDate: new Date()
        },
        select: CIPHER_SELECT
    });
    if (input.favorite !== null && input.favorite !== undefined) {
        await setFavorite(userId, cipherId, input.favorite);
    }
    await bumpRevision(userId);
    const favorite = await prisma.vaultFavorite.findUnique({
        where: { userId_cipherId: { userId, cipherId } },
        select: { userId: true }
    });
    return { ok: true, cipher: toCipherResponse(row, favorite !== null) };
}

/** Star an item, or take the star off. Per person, even on a shared item. */
export async function setFavorite(
    userId: string,
    cipherId: string,
    favorite: boolean
): Promise<void> {
    if (favorite) {
        await prisma.vaultFavorite
            .create({ data: { userId, cipherId } })
            .catch(() => undefined);
        return;
    }
    await prisma.vaultFavorite.deleteMany({ where: { userId, cipherId } });
}

/**
 * Where the ciphertext of a set of items' attachments is stored.
 *
 * Read before the items go, never after: the attachment rows cascade with them,
 * and once they are gone nothing names the bytes any more.
 */
async function attachmentPaths(cipherIds: string[]): Promise<string[]> {
    if (cipherIds.length === 0) return [];
    const rows = await prisma.vaultAttachment.findMany({
        where: { cipherId: { in: cipherIds } },
        select: { storedPath: true }
    });
    return rows.map((row) => row.storedPath);
}

/**
 * Send items to the trash, or take them out for good.
 *
 * Soft by default because clients draw a trash and expect restore to work; the
 * hard delete is what emptying it does - and a hard delete takes the attachment
 * bytes with it, because a cascade only reaches rows and ciphertext left on a
 * share with nothing pointing at it is unreclaimable.
 */
export async function deleteCiphers(
    userId: string,
    cipherIds: string[],
    soft: boolean
): Promise<number> {
    const writable: string[] = [];
    for (const id of cipherIds) {
        if (await mayWrite(userId, id)) writable.push(id);
    }
    if (writable.length === 0) return 0;
    if (soft) {
        const { count } = await prisma.vaultCipher.updateMany({
            where: { id: { in: writable } },
            data: { deletedDate: new Date(), revisionDate: new Date() }
        });
        await bumpRevision(userId);
        return count;
    }
    const paths = await attachmentPaths(writable);
    const { count } = await prisma.vaultCipher.deleteMany({ where: { id: { in: writable } } });
    for (const path of paths) await deleteVaultBlob(path);
    await bumpRevision(userId);
    return count;
}

/** Take items back out of the trash. */
export async function restoreCiphers(userId: string, cipherIds: string[]): Promise<number> {
    const writable: string[] = [];
    for (const id of cipherIds) {
        if (await mayWrite(userId, id)) writable.push(id);
    }
    if (writable.length === 0) return 0;
    const { count } = await prisma.vaultCipher.updateMany({
        where: { id: { in: writable } },
        data: { deletedDate: null, revisionDate: new Date() }
    });
    await bumpRevision(userId);
    return count;
}

/**
 * Move items between folders. Folders are personal, so this only ever touches
 * the caller's own items - moving somebody else's shared login into your folder
 * would move it into theirs too.
 */
export async function moveCiphers(
    userId: string,
    cipherIds: string[],
    folderId: string | null
): Promise<void> {
    await prisma.vaultCipher.updateMany({
        where: { id: { in: cipherIds }, userId },
        data: { folderId: await ownFolderId(userId, folderId), revisionDate: new Date() }
    });
    await bumpRevision(userId);
}

/**
 * Hand a personal item to an organization.
 *
 * The client re-encrypted it under the organization's key before calling, which
 * is why the whole item is sent again: this is not a change of owner on a row,
 * it is a different ciphertext that happens to replace one.
 */
export async function shareCipher(
    userId: string,
    cipherId: string,
    input: CipherInput,
    collectionIds: string[]
): Promise<CipherWriteResult> {
    const owned = await prisma.vaultCipher.findFirst({
        where: { id: cipherId, userId },
        select: { id: true }
    });
    if (!owned || !input.organizationId) return { ok: false, reason: "not_found" };
    // Owning the item says it may leave; standing in the organization says it may
    // arrive. Without the second, anybody could push an item into a vault they
    // are not in and every member of it would sync a copy.
    const collections = await writableCollections(userId, input.organizationId, collectionIds);
    if (collections === null || collections.length === 0) return { ok: false, reason: "not_found" };

    const row = await prisma.$transaction(async (tx) => {
        await tx.vaultCollectionCipher.deleteMany({ where: { cipherId } });
        return tx.vaultCipher.update({
            where: { id: cipherId },
            data: {
                userId: null,
                organizationId: input.organizationId,
                data: toDocument(input),
                type: input.type,
                reprompt: input.reprompt ?? 0,
                revisionDate: new Date(),
                collections: { create: collections.map((collectionId) => ({ collectionId })) }
            },
            select: CIPHER_SELECT
        });
    });
    await bumpRevision(userId);
    return { ok: true, cipher: toCipherResponse(row, false) };
}

/** Empty a personal vault. Organization items are not the caller's to purge. */
export async function purgeCiphers(userId: string): Promise<void> {
    const owned = await prisma.vaultCipher.findMany({ where: { userId }, select: { id: true } });
    const paths = await attachmentPaths(owned.map((row) => row.id));
    await prisma.$transaction([
        prisma.vaultCipher.deleteMany({ where: { userId } }),
        prisma.vaultFolder.deleteMany({ where: { userId } })
    ]);
    for (const path of paths) await deleteVaultBlob(path);
    await bumpRevision(userId);
}
