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
                              some: {
                                  collection: {
                                      members: { some: { orgUserId: { in: memberIds } } }
                                  }
                              }
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

/**
 * Whether this account starred an item.
 *
 * A star is per person and lives in its own table, so it is never on the row a
 * write returns - every response has to look it up. Answering `false` instead
 * would make a client apply the response and quietly unstar what it is holding.
 */
async function isStarred(userId: string, cipherId: string): Promise<boolean> {
    const row = await prisma.vaultFavorite.findUnique({
        where: { userId_cipherId: { userId, cipherId } },
        select: { userId: true }
    });
    return row !== null;
}

/** The same answer for a list of items, in one query. */
async function starredIds(userId: string, cipherIds: string[]): Promise<Set<string>> {
    if (cipherIds.length === 0) return new Set();
    const rows = await prisma.vaultFavorite.findMany({
        where: { userId, cipherId: { in: cipherIds } },
        select: { cipherId: true }
    });
    return new Set(rows.map((row) => row.cipherId));
}

/** Every item this account can see, trash included - clients draw the trash. */
export async function listCiphers(userId: string) {
    const [rows, favorites] = await Promise.all([
        prisma.vaultCipher.findMany({
            where: await reachableCipherFilter(userId),
            select: CIPHER_SELECT
        }),
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
    return toCipherResponse(row, await isStarred(userId, cipherId));
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
                                              some: {
                                                  orgUserId: { in: memberIds },
                                                  readOnly: false
                                              }
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
        // Naming collections that all turn out to be somebody else's would
        // otherwise write the item into the vault with nothing pointing at it.
        if (collectionIds.length > 0 && allowed.length === 0) return null;
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
    return { ok: true, cipher: toCipherResponse(row, await isStarred(userId, cipherId)) };
}

/**
 * Change only where an item is filed and whether it is starred.
 *
 * Neither of those is inside the ciphertext, so a client can send them without
 * having the item open - which is exactly why Bitwarden gives them their own
 * endpoint, and why this one never touches `data`.
 */
export async function updateCipherPartial(
    userId: string,
    cipherId: string,
    changes: { folderId?: string | null; favorite?: boolean | null }
): Promise<CipherWriteResult> {
    if (!(await mayWrite(userId, cipherId))) return { ok: false, reason: "not_found" };
    const row = await prisma.vaultCipher.update({
        where: { id: cipherId },
        data: {
            // Undefined leaves it where it is; null is "no folder", which is a
            // change a client does make.
            ...(changes.folderId === undefined
                ? {}
                : { folderId: await ownFolderId(userId, changes.folderId) }),
            revisionDate: new Date()
        },
        select: CIPHER_SELECT
    });
    if (changes.favorite !== null && changes.favorite !== undefined) {
        await setFavorite(userId, cipherId, changes.favorite);
    }
    await bumpRevision(userId);
    return { ok: true, cipher: toCipherResponse(row, await isStarred(userId, cipherId)) };
}

/**
 * Set which of an organization's collections an item is in.
 *
 * Only for an item that already belongs to a vault: putting a personal item into
 * a collection is `moveCipher`, because that one has to be re-encrypted under the
 * vault's key first and this one must not look like a way around it.
 */
export async function setCipherCollections(
    userId: string,
    cipherId: string,
    collectionIds: string[]
): Promise<CipherWriteResult> {
    if (!(await mayWrite(userId, cipherId))) return { ok: false, reason: "not_found" };
    const current = await prisma.vaultCipher.findUnique({
        where: { id: cipherId },
        select: { organizationId: true }
    });
    if (!current?.organizationId) return { ok: false, reason: "not_found" };
    const allowed = await writableCollections(userId, current.organizationId, collectionIds);
    if (allowed === null) return { ok: false, reason: "not_found" };

    const row = await prisma.$transaction(async (tx) => {
        await tx.vaultCollectionCipher.deleteMany({ where: { cipherId } });
        if (allowed.length > 0) {
            await tx.vaultCollectionCipher.createMany({
                data: allowed.map((collectionId) => ({ cipherId, collectionId }))
            });
        }
        return tx.vaultCipher.update({
            where: { id: cipherId },
            data: { revisionDate: new Date() },
            select: CIPHER_SELECT
        });
    });
    await bumpRevision(userId);
    return { ok: true, cipher: toCipherResponse(row, await isStarred(userId, cipherId)) };
}

/** Every item of one organization this account can see. */
export async function listOrganizationCiphers(userId: string, organizationId: string) {
    const filter = await reachableCipherFilter(userId);
    const rows = await prisma.vaultCipher.findMany({
        where: { AND: [{ organizationId }, filter] },
        select: CIPHER_SELECT
    });
    const starred = await starredIds(
        userId,
        rows.map((row) => row.id)
    );
    return rows.map((row) => toCipherResponse(row, starred.has(row.id)));
}

/**
 * A whole vault arriving at once, from a client's own import screen.
 *
 * The folders have to exist before the items can point at them, and the pairing
 * between the two is positional - which is why this is one function rather than
 * the client making a call per row: half an import is worse than none, and the
 * indexes only mean anything while both lists are in hand.
 *
 * "Half an import is worse than none" is why the writes are one transaction: a
 * failure part-way would otherwise leave the folders standing and some of the
 * items in them, with nothing saying which. The size of that transaction is
 * bounded by `vaultImportSchema`, which caps both lists.
 *
 * Personal only. An import that could name an organization would be a way to
 * push items into somebody else's vault in bulk.
 */
export async function importCiphers(
    userId: string,
    input: {
        folders: { name: string }[];
        ciphers: CipherInput[];
        folderRelationships: { key: number; value: number }[];
    }
): Promise<number> {
    const written = await prisma.$transaction(
        async (tx) => {
            // One create per folder, because the ids are generated on insert and
            // the relationships below are positional against them.
            const folderIds: string[] = [];
            for (const folder of input.folders) {
                const row = await tx.vaultFolder.create({
                    data: { userId, name: folder.name },
                    select: { id: true }
                });
                folderIds.push(row.id);
            }
            const folderOf = new Map<number, string>();
            for (const link of input.folderRelationships) {
                const id = folderIds[link.value];
                if (id) folderOf.set(link.key, id);
            }

            const { count } = await tx.vaultCipher.createMany({
                data: input.ciphers.map((cipher, index) => ({
                    userId,
                    organizationId: null,
                    folderId: folderOf.get(index) ?? null,
                    type: cipher.type,
                    data: toDocument(cipher),
                    reprompt: cipher.reprompt ?? 0
                }))
            });
            return count;
        },
        { maxWait: 10_000, timeout: 120_000 }
    );
    await bumpRevision(userId);
    return written;
}

/** Star an item, or take the star off. Per person, even on a shared item. */
export async function setFavorite(
    userId: string,
    cipherId: string,
    favorite: boolean
): Promise<void> {
    if (favorite) {
        await prisma.vaultFavorite.create({ data: { userId, cipherId } }).catch(() => undefined);
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

/** The same, for everything one vault holds - read before the vault goes. */
export async function vaultAttachmentPaths(vaultId: string): Promise<string[]> {
    const rows = await prisma.vaultAttachment.findMany({
        where: { cipher: { organizationId: vaultId } },
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
 * Move an item into a vault, into a different one, or back to being personal.
 *
 * The caller re-encrypted it under the key of wherever it is going before
 * calling, which is why the whole item is sent again: this is not a change of
 * owner on a row, it is a different ciphertext that happens to replace one.
 *
 * Two questions, and they are separate. Being able to write the item says it may
 * leave; standing where it is going says it may arrive. Without the second,
 * anybody could push an item into a vault they are not in and every member of it
 * would sync a copy.
 *
 * Everybody who already synced it keeps their copy - a key cannot be un-given -
 * so this changes where the item is kept from now on, not where it has been.
 */
export async function moveCipher(
    userId: string,
    cipherId: string,
    input: CipherInput,
    collectionIds: string[]
): Promise<CipherWriteResult> {
    if (!(await mayWrite(userId, cipherId))) return { ok: false, reason: "not_found" };
    const target = input.organizationId ?? null;
    let collections: string[] = [];
    if (target) {
        const allowed = await writableCollections(userId, target, collectionIds);
        // No collection means an item only an administrator of that vault would
        // ever see again, which is not a move anybody meant to make.
        if (allowed === null || allowed.length === 0) return { ok: false, reason: "not_found" };
        collections = allowed;
    }

    const folderId = target ? null : await ownFolderId(userId, input.folderId);
    const row = await prisma.$transaction(async (tx) => {
        await tx.vaultCollectionCipher.deleteMany({ where: { cipherId } });
        return tx.vaultCipher.update({
            where: { id: cipherId },
            data: {
                // An item belongs to a person or to a vault, never both: the key
                // it is encrypted under is one or the other.
                userId: target ? null : userId,
                organizationId: target,
                folderId,
                data: toDocument(input),
                type: input.type,
                reprompt: input.reprompt ?? 0,
                revisionDate: new Date(),
                ...(collections.length > 0
                    ? { collections: { create: collections.map((collectionId) => ({ collectionId })) } }
                    : {})
            },
            select: CIPHER_SELECT
        });
    });
    await bumpRevision(userId);
    return { ok: true, cipher: toCipherResponse(row, await isStarred(userId, cipherId)) };
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
