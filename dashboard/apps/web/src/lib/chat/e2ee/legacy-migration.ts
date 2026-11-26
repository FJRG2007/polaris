/**
 * Migration of an existing conversation's plain history to sealed
 * (docs/chat-e2ee-mls.md, "Migration of existing chats"; proposal 8).
 *
 * The server seals it, because the people in it may never come back and the
 * server already held this text: sealing it adds no exposure and ends the
 * future one. Per conversation:
 *
 * 1. A one-time history key `HK(c, legacy)` and a one-time Ed25519 signing key
 *    are made in memory. `HK` is sealed to every member's account key
 *    (`ChatHistoryKey`, epoch `LEGACY_EPOCH`) before anything is sealed under
 *    it; a conversation where nobody has an account key yet stays pending.
 * 2. Every plain message (and every earlier version in its edit history) is
 *    sealed exactly as a browser seals one - same content format, same
 *    binding, `messageId` its `clientKey` (its row id when it had none),
 *    sender leaf 0, signed by the one-time key - so the readers that open
 *    sealed messages today open these with no change.
 * 3. Verification: every sealed row is opened again with `HK` and compared
 *    with the plain text it came from; any difference leaves the conversation
 *    failed, still plain, and nothing is cut.
 * 4. Cut: the conversation becomes sealed only (`conversationSealed`), and
 *    each row's plain text moves to `ChatMigrationRollback` (the 30-day
 *    rollback, decision 4) in the same statement that empties it, guarded on
 *    the text still being what was sealed.
 * 5. `HK` and the signing key are dropped: the server keeps nothing that opens
 *    the migrated history.
 *
 * Resumable: a conversation found `converting` was interrupted, so its
 * half-done seal (rows still hold their plain text) is cleared and it starts
 * again under a fresh key. Repeating a finished conversation changes nothing.
 */

import * as core from "@polaris/core";
import { chatE2eeEnabled } from "./flag";
import { prisma, Prisma } from "@polaris/db";
import { conversationAudience } from "@/lib/chat/access";
import * as content from "@polaris/chat-crypto/message-content";
import { accountPublicKeys, putHistoryKeys } from "./mls-delivery";
import { encodeSealedContent, decodeSealedContent, type SealedContent } from "./sealed-chat";

import { LEGACY_EPOCH } from "./mls-history-keys";
import { restoreAnnotations } from "./annotation-rollback";

export { LEGACY_EPOCH };
/** What a migrated row names as its device. */
export const MIGRATION_DEVICE = "migration";
/** The sender leaf migrated rows are bound to (they came from no MLS leaf). */
const LEGACY_LEAF = 0;
const BATCH = 200;
const KEY_PAGE = 100;
/** Rounds of "seal what arrived since" before a conversation is left for the next run. */
const CATCH_UP_ROUNDS = 5;
/** What the binding's `signContent` puts in front of the payload (polaris_core::mls::CONTENT_SIGNATURE_LABEL, `message-content.ts`). */
const CONTENT_SIGNATURE_LABEL = new TextEncoder().encode("polaris/chat-e2ee/content-signature/v1\u0000");

export type MigrationOutcome = "cut" | "pending" | "failed" | "off";

type Signer = { readonly privateKey: CryptoKey; readonly publicKey: Uint8Array };

type PlainRow = {
    id: string;
    clientKey: string | null;
    body: string;
    translation: Prisma.JsonValue;
    edits: { id: string; body: string }[];
};

/** Rows the migrator seals: text messages (not system notices or call cards) with words, not sealed by a device. */
const plainWhere = (channelId: string): Prisma.ChatMessageWhereInput => ({
    channelId,
    kind: "text",
    body: { not: "" },
    OR: [{ e2eeCiphertext: null }, { e2eeDevice: MIGRATION_DEVICE }]
});

const owned = (value: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(value);
const translationSchema = core.chatSendSchema.shape.translation;
const bodySchema = core.chatSendSchema.shape.body;

/** What a plain row seals to, or null when its text is not one a reader could open (the conversation then fails). */
export function contentOf(body: string, translation: Prisma.JsonValue): SealedContent | null {
    if (!bodySchema.safeParse(body).success) return null;
    const parsed = translation == null ? null : translationSchema.safeParse(translation);
    return parsed?.success && parsed.data ? { body, translation: parsed.data } : { body };
}

export async function newSigner(): Promise<Signer> {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
    return { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

/** Seal and sign one version of a migrated message. */
export async function sealVersion(historyKey: Uint8Array, signer: Signer, binding: content.MessageBinding, version: SealedContent) {
    const ciphertext = await content.sealMessage(historyKey, binding, encodeSealedContent(version));
    const payload = await content.messageSignaturePayload(binding, ciphertext);
    const signed = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, signer.privateKey, owned(new Uint8Array([...CONTENT_SIGNATURE_LABEL, ...payload]))));
    return {
        e2eeCiphertext: owned(ciphertext),
        e2eeEpoch: LEGACY_EPOCH,
        e2eeSenderLeaf: LEGACY_LEAF,
        e2eeDevice: MIGRATION_DEVICE,
        e2eeSignature: owned(signed),
        e2eeSignatureKey: owned(signer.publicKey),
        e2eeRevision: binding.revision ? binding.revision : null
    };
}

/** The people the conversation is said to; null when nobody is left to ask on behalf of. */
export async function audienceOf(channelId: string): Promise<string[] | null> {
    const member = await prisma.chatChannelMember.findFirst({ where: { channelId }, select: { userId: true }, orderBy: { userId: "asc" } });
    const owner = member
        ? null
        : await prisma.chatChannel.findUnique({ where: { id: channelId }, select: { space: { select: { ownerId: true } } } });
    const actor = member?.userId ?? owner?.space?.ownerId;
    return actor ? await conversationAudience({ id: actor }, channelId) : null;
}

/** Seal `HK` (of `epoch`, the legacy one by default) to every member account that has a key; how many it was sealed to. */
export async function sealToMembers(channelId: string, audience: readonly string[], historyKey: Uint8Array, epoch: bigint = LEGACY_EPOCH): Promise<number> {
    let sealedTo = 0;
    for (let at = 0; at < audience.length; at += KEY_PAGE) {
        const keys = await accountPublicKeys(audience.slice(at, at + KEY_PAGE));
        const envelopes = await Promise.all(
            keys.map(async (key) => ({
                recipient: key.userId,
                envelope: await content.sealHistoryKey(new Uint8Array(key.hpkePublicKey), historyKey, { recipient: key.userId, conversationId: channelId, epoch })
            }))
        );
        if (envelopes.length) await putHistoryKeys(channelId, epoch, envelopes);
        sealedTo += envelopes.length;
    }
    return sealedTo;
}

/** Undo an interrupted run: its rows still hold their plain text, so clearing the seal loses nothing. */
async function clearHalfDone(channelId: string): Promise<void> {
    const cleared = { e2eeCiphertext: null, e2eeEpoch: null, e2eeSenderLeaf: null, e2eeDevice: null, e2eeSignature: null, e2eeSignatureKey: null, e2eeRevision: null };
    await prisma.$transaction([
        prisma.chatMessageEdit.updateMany({ where: { message: { channelId }, e2eeDevice: MIGRATION_DEVICE, body: { not: "" } }, data: cleared }),
        prisma.chatMessage.updateMany({ where: { channelId, e2eeDevice: MIGRATION_DEVICE, body: { not: "" } }, data: cleared }),
        prisma.chatHistoryKey.deleteMany({ where: { channelId, epoch: LEGACY_EPOCH } })
    ]);
}

const plainSelect = {
    id: true,
    clientKey: true,
    body: true,
    translation: true,
    edits: { select: { id: true, body: true }, orderBy: [{ replacedAt: "asc" }, { id: "asc" }] }
} satisfies Prisma.ChatMessageSelect;

/**
 * Seal one message and its edit history: the edits are revisions 0..n-1 in the
 * order they were replaced, the message as it stands is revision n. Null when
 * a version is not one a reader could open.
 */
async function sealRow(channelId: string, row: PlainRow, historyKey: Uint8Array, signer: Signer): Promise<Prisma.PrismaPromise<unknown>[] | null> {
    const messageId = row.clientKey ?? row.id;
    const writes: Prisma.PrismaPromise<unknown>[] = [];
    for (const [revision, edit] of row.edits.entries()) {
        const version = contentOf(edit.body, null);
        if (!version) return null;
        const sealed = await sealVersion(historyKey, signer, { conversationId: channelId, epoch: LEGACY_EPOCH, messageId, senderLeaf: LEGACY_LEAF, revision }, version);
        writes.push(prisma.chatMessageEdit.update({ where: { id: edit.id }, data: sealed }));
    }
    const version = contentOf(row.body, row.translation);
    if (!version) return null;
    const binding = { conversationId: channelId, epoch: LEGACY_EPOCH, messageId, senderLeaf: LEGACY_LEAF, revision: row.edits.length };
    const sealed = await sealVersion(historyKey, signer, binding, version);
    writes.push(prisma.chatMessage.update({ where: { id: row.id }, data: { ...sealed, clientKey: messageId } }));
    return writes;
}

/** Whether a sealed version opens under `HK` to exactly the plain text it came from. */
async function opensTo(historyKey: Uint8Array, binding: content.MessageBinding, sealed: Uint8Array | null, expected: SealedContent | null): Promise<boolean> {
    if (!sealed || !expected) return false;
    const opened = await content.openMessage(historyKey, binding, new Uint8Array(sealed)).catch(() => null);
    const decoded = opened ? decodeSealedContent(opened) : null;
    return decoded !== null && JSON.stringify(decoded) === JSON.stringify(expected);
}

const verifySelect = {
    id: true,
    clientKey: true,
    body: true,
    translation: true,
    e2eeCiphertext: true,
    e2eeDevice: true,
    edits: { select: { id: true, body: true, e2eeCiphertext: true, e2eeDevice: true }, orderBy: [{ replacedAt: "asc" }, { id: "asc" }] }
} satisfies Prisma.ChatMessageSelect;

type VerifyRow = Prisma.ChatMessageGetPayload<{ select: typeof verifySelect }>;

/** Whether every version of a migrated row opens to its plain text (M3). */
async function rowVerifies(channelId: string, row: VerifyRow, historyKey: Uint8Array): Promise<boolean> {
    if (!row.clientKey || row.e2eeDevice !== MIGRATION_DEVICE) return false;
    const base = { conversationId: channelId, epoch: LEGACY_EPOCH, messageId: row.clientKey, senderLeaf: LEGACY_LEAF };
    for (const [revision, edit] of row.edits.entries())
        if (edit.e2eeDevice !== MIGRATION_DEVICE || !(await opensTo(historyKey, { ...base, revision }, edit.e2eeCiphertext, contentOf(edit.body, null)))) return false;
    return opensTo(historyKey, { ...base, revision: row.edits.length }, row.e2eeCiphertext, contentOf(row.body, row.translation));
}

/** Seal every plain row not sealed yet; false when one cannot be sealed. */
async function sealPending(channelId: string, historyKey: Uint8Array, signer: Signer): Promise<boolean> {
    for (;;) {
        const rows = await prisma.chatMessage.findMany({
            where: { ...plainWhere(channelId), e2eeCiphertext: null },
            select: plainSelect,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: BATCH
        });
        if (!rows.length) return true;
        for (const row of rows) {
            const writes = await sealRow(channelId, row, historyKey, signer);
            if (!writes) return false;
            // Only over a row still as it was read: a plain edit since is sealed on the next pass.
            await prisma.$transaction(writes);
        }
    }
}

/**
 * Verify every migrated row (M3) and, with `empty`, move its plain text to the
 * rollback copy and empty it, guarded on the text still being what was
 * verified. A row whose text changed meanwhile is sealed again ("again").
 */
async function verifyRows(channelId: string, historyKey: Uint8Array, signer: Signer, empty: boolean): Promise<"done" | "again" | "mismatch"> {
    let after: string | undefined;
    let again = false;
    for (;;) {
        const rows: VerifyRow[] = await prisma.chatMessage.findMany({
            where: { ...plainWhere(channelId), e2eeDevice: MIGRATION_DEVICE, ...(after ? { id: { gt: after } } : {}) },
            select: verifySelect,
            orderBy: { id: "asc" },
            take: BATCH
        });
        if (!rows.length) return again ? "again" : "done";
        after = rows[rows.length - 1]!.id;
        for (const row of rows) {
            if (!(await rowVerifies(channelId, row, historyKey))) {
                // The text moved since it was sealed (a plain edit before the cut): seal it again.
                const fresh = await prisma.chatMessage.findUnique({ where: { id: row.id }, select: plainSelect });
                const writes = fresh ? await sealRow(channelId, fresh, historyKey, signer) : null;
                if (!writes) return "mismatch";
                await prisma.$transaction(writes);
                again = true;
                continue;
            }
            if (!empty) continue;
            const emptied = await prisma.$transaction(async (tx) => {
                const done = await tx.chatMessage.updateMany({
                    where: { id: row.id, body: row.body, e2eeCiphertext: { equals: row.e2eeCiphertext ?? undefined } },
                    data: { body: "", translation: Prisma.DbNull }
                });
                if (!done.count) return false;
                await tx.chatMigrationRollback.createMany({
                    data: [
                        { kind: "message", id: row.id, messageId: row.id, channelId, body: row.body, translation: row.translation ?? Prisma.DbNull },
                        ...row.edits.map((edit) => ({ kind: "edit", id: edit.id, messageId: row.id, channelId, body: edit.body }))
                    ],
                    skipDuplicates: true
                });
                if (row.edits.length) await tx.chatMessageEdit.updateMany({ where: { id: { in: row.edits.map((edit) => edit.id) } }, data: { body: "" } });
                return true;
            });
            if (!emptied) again = true;
        }
    }
}

/**
 * Migrate one conversation (see the header). Answers where it ended: `cut`,
 * `pending` (nobody to seal it to yet), `failed` (a version did not verify or
 * cannot be sealed; it stays plain), or `off` when sealed chat is off.
 */
export async function migrateConversation(channelId: string): Promise<MigrationOutcome> {
    if (!chatE2eeEnabled()) return "off";
    const state = await prisma.chatMigration.upsert({ where: { channelId }, create: { channelId }, update: {}, select: { state: true } });
    // A cut never goes back: its history key is gone, so nothing could seal under it again.
    if (state.state === "cut") return "cut";
    // Not cut means nothing was emptied: whatever an earlier run sealed still has its plain text.
    await clearHalfDone(channelId);

    const settle = async (outcome: "pending" | "failed", reason: string): Promise<MigrationOutcome> => {
        await clearHalfDone(channelId);
        await prisma.chatMigration.update({ where: { channelId }, data: { state: outcome, reason, signKey: null } });
        return outcome;
    };

    const audience = await audienceOf(channelId);
    if (!audience?.length) return settle("pending", "noMembers");
    const historyKey = content.newHistoryKey();
    try {
        // Sealed to the members before anything is sealed under it: a crash in between leaves envelopes, never orphaned rows.
        if (!(await sealToMembers(channelId, audience, historyKey))) return settle("pending", "noAccountKey");
        const signer = await newSigner();
        await prisma.chatMigration.update({ where: { channelId }, data: { state: "converting", reason: null, signKey: owned(signer.publicKey) } });

        // M2 and M3 with nothing emptied: any failure here leaves the conversation exactly as it was.
        for (let round = 0; ; round++) {
            if (!(await sealPending(channelId, historyKey, signer))) return settle("failed", "unsealable");
            const outcome = await verifyRows(channelId, historyKey, signer, false);
            if (outcome === "mismatch") return settle("failed", "mismatch");
            if (outcome === "done") break;
            if (round >= CATCH_UP_ROUNDS) return settle("pending", "busy");
        }
        // M4: from here plain writes are refused (`conversationSealed`); what slipped in before is sealed below.
        await prisma.chatMigration.update({ where: { channelId }, data: { state: "cut", cutAt: new Date() } });
        let reason: string | null = "stragglers";
        for (let round = 0; round <= CATCH_UP_ROUNDS; round++) {
            if (!(await sealPending(channelId, historyKey, signer))) break;
            const outcome = await verifyRows(channelId, historyKey, signer, true);
            if (outcome === "mismatch") break;
            if (outcome === "done" && !(await prisma.chatMessage.count({ where: plainWhere(channelId), take: 1 }))) {
                reason = null;
                break;
            }
        }
        // A row left plain here raced the cut and did not settle: it stays readable as it was, and the line says so.
        if (reason) console.error("polaris: a migrated conversation kept plain rows after its cut:", channelId);
        const sealed = await prisma.chatMessage.count({ where: { channelId, e2eeDevice: MIGRATION_DEVICE } });
        await prisma.chatMigration.update({ where: { channelId }, data: { reason, sealed } });
        return "cut";
    } finally {
        historyKey.fill(0);
    }
}

/**
 * Whether the migration may start: a backup of Polaris's own database that
 * finished within the last day (proposal 8.5). Without one nothing is sealed
 * or emptied, and the admin line says so.
 */
export async function backupReady(now = new Date()): Promise<boolean> {
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const point = await prisma.recoveryPoint.findFirst({
        where: { status: "available", takenAt: { gte: since }, resource: { kind: "polaris-database" } },
        select: { id: true }
    });
    return Boolean(point);
}

/** Conversations with plain history the migrator has not cut, a page at a time. */
async function nextConversations(after: string | null, take: number): Promise<string[]> {
    const rows = await prisma.chatChannel.findMany({
        where: {
            ...(after ? { id: { gt: after } } : {}),
            messages: { some: { kind: "text", body: { not: "" }, e2eeCiphertext: null } },
            // A cut conversation's history key is gone; one kept with stragglers is reported, not retried.
            // One rolled back stays plain until an admin migrates it again.
            NOT: { migration: { state: { in: ["cut", "rolledBack"] } } }
        },
        select: { id: true },
        orderBy: { id: "asc" },
        take
    });
    return rows.map((row) => row.id);
}

/**
 * One pass over every conversation with plain history, one at a time with a
 * pause between them so a busy instance keeps answering. Nothing runs while
 * sealed chat is off or there is no recent backup.
 */
export async function runLegacyMigration(options: { pauseMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<Record<MigrationOutcome, number>> {
    const counts: Record<MigrationOutcome, number> = { cut: 0, pending: 0, failed: 0, off: 0 };
    if (!chatE2eeEnabled()) return counts;
    await purgeRollbackCopies();
    if (!(await backupReady())) return counts;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let after: string | null = null;
    for (;;) {
        const page = await nextConversations(after, 50);
        if (!page.length) return counts;
        for (const channelId of page) {
            try {
                counts[await migrateConversation(channelId)]++;
            } catch (caught) {
                // One conversation's failure never stops the rest; it is tried again on the next pass.
                counts.failed++;
                console.error("polaris: a conversation could not be migrated to sealed:", channelId, caught);
            }
            await sleep(options.pauseMs ?? 250);
        }
        after = page[page.length - 1]!;
    }
}

/** What the admin line shows: how many conversations with history are cut, and why the rest are not. */
export async function migrationProgress(): Promise<{ cut: number; remaining: number; failed: number; rolledBack: number; waitingOnBackup: boolean }> {
    const [cut, failed, rolledBack, remaining, ready] = await Promise.all([
        prisma.chatMigration.count({ where: { state: "cut" } }),
        prisma.chatMigration.count({ where: { state: "failed" } }),
        prisma.chatMigration.count({ where: { state: "rolledBack" } }),
        prisma.chatChannel.count({
            where: { messages: { some: { kind: "text", body: { not: "" }, e2eeCiphertext: null } }, NOT: { migration: { state: "rolledBack" } } }
        }),
        backupReady()
    ]);
    return { cut, remaining, failed, rolledBack, waitingOnBackup: !ready };
}

/** How long a cut conversation's plain text is kept for a rollback (proposal 13, decision 4). */
export const ROLLBACK_DAYS = 30;
const PURGE_BATCH = 1000;

function rollbackSince(now: Date): Date {
    return new Date(now.getTime() - ROLLBACK_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Delete the plain copies older than the rollback window, a batch at a time so
 * a large instance never holds one long statement. After this the migrated
 * history exists only sealed. Returns how many copies went.
 */
export async function purgeRollbackCopies(now = new Date()): Promise<number> {
    const before = rollbackSince(now);
    let purged = 0;
    for (;;) {
        const gone = await prisma.$executeRaw`DELETE FROM "ChatMigrationRollback" WHERE ctid IN (SELECT ctid FROM "ChatMigrationRollback" WHERE "createdAt" < ${before} LIMIT ${PURGE_BATCH})`;
        purged += gone;
        if (gone < PURGE_BATCH) return purged;
    }
}

export type RollbackOutcome = { restored: number; kept: number } | "notCut" | "expired";

const unsealed = { e2eeCiphertext: null, e2eeEpoch: null, e2eeSenderLeaf: null, e2eeDevice: null, e2eeSignature: null, e2eeSignatureKey: null, e2eeRevision: null };

/**
 * Put a cut conversation's history back as it was before the migration, from
 * its plain copies: each message the migrator sealed gets its text (and its
 * edit history) back and loses the seal, in one transaction per message,
 * guarded on the row still being the migrator's seal. A message edited sealed
 * after the cut keeps its seal and its copies (`kept`): its text moved on, so
 * the copy no longer says what it does. Repeating it after a crash finishes
 * the rest. The conversation is then `rolledBack` - the migrator skips it
 * until `migrateAgain` - and the legacy key envelopes go once no row needs
 * them. A conversation with its own MLS group stays sealed only for new
 * writes: only the migrated past becomes plain.
 */
export async function rollBackConversation(channelId: string, now = new Date()): Promise<RollbackOutcome> {
    const migration = await prisma.chatMigration.findUnique({ where: { channelId }, select: { state: true, cutAt: true } });
    if (migration?.state !== "cut") return "notCut";
    if (!migration.cutAt || migration.cutAt < rollbackSince(now)) return "expired";
    let restored = 0;
    let kept = 0;
    let after: string | null = null;
    for (;;) {
        const page: { messageId: string }[] = await prisma.chatMigrationRollback.findMany({
            where: { channelId, kind: "message", ...(after ? { messageId: { gt: after } } : {}) },
            select: { messageId: true },
            orderBy: { messageId: "asc" },
            take: BATCH
        });
        if (!page.length) break;
        after = page[page.length - 1]!.messageId;
        const ids = page.map((m) => m.messageId);
        const copies = await prisma.chatMigrationRollback.findMany({
            where: { channelId, messageId: { in: ids }, kind: { in: ["message", "edit"] } },
            select: { id: true, kind: true, messageId: true, body: true, translation: true }
        });
        for (const messageId of ids) {
            const own = copies.filter((copy) => copy.messageId === messageId);
            const message = own.find((copy) => copy.kind === "message")!;
            const done = await prisma.$transaction(async (tx) => {
                const back = await tx.chatMessage.updateMany({
                    where: { id: messageId, channelId, e2eeDevice: MIGRATION_DEVICE, body: "" },
                    data: { ...unsealed, body: message.body, translation: message.translation ?? Prisma.DbNull }
                });
                if (!back.count) return false;
                for (const edit of own.filter((copy) => copy.kind === "edit"))
                    await tx.chatMessageEdit.updateMany({ where: { id: edit.id, messageId, e2eeDevice: MIGRATION_DEVICE, body: "" }, data: { ...unsealed, body: edit.body } });
                // The message's own copies only: its swept reactions and votes are put back below.
                await tx.chatMigrationRollback.deleteMany({ where: { messageId, kind: { in: ["message", "edit"] } } });
                return true;
            });
            if (done) restored++;
            else kept++;
        }
    }
    // The reactions and votes the sweep sealed, back in the clear where nobody has changed them since.
    await restoreAnnotations(channelId);
    const stillSealed = await prisma.chatMessage.count({ where: { channelId, e2eeDevice: MIGRATION_DEVICE }, take: 1 });
    if (!stillSealed) await prisma.chatHistoryKey.deleteMany({ where: { channelId, epoch: LEGACY_EPOCH } });
    await prisma.chatMigration.update({ where: { channelId }, data: { state: "rolledBack", reason: kept ? "keptEdited" : null, signKey: null } });
    return { restored, kept };
}

/** Let the migrator take a rolled-back conversation again on its next pass. */
export async function migrateAgain(channelId: string): Promise<boolean> {
    const moved = await prisma.chatMigration.updateMany({ where: { channelId, state: "rolledBack" }, data: { state: "pending", reason: null, cutAt: null } });
    return moved.count > 0;
}

export type MigratedConversation = {
    channelId: string;
    state: "cut" | "failed" | "rolledBack";
    reason: string | null;
    /** The channel's and its space's name; null for a direct or group message, whose people are not the admin's to see. */
    name: string | null;
    space: string | null;
    cutAt: string | null;
    /** Whether its plain copies are still inside the rollback window. */
    canRollBack: boolean;
};

/** The conversations an admin can act on, latest first: cut (rollback), rolled back (migrate again) and failed. */
export async function migratedConversations(now = new Date(), take = 20): Promise<MigratedConversation[]> {
    const since = rollbackSince(now);
    const rows = await prisma.chatMigration.findMany({
        where: { OR: [{ state: "cut", cutAt: { gte: since } }, { state: { in: ["failed", "rolledBack"] } }] },
        select: { channelId: true, state: true, reason: true, cutAt: true, channel: { select: { name: true, dmKey: true, space: { select: { name: true } } } } },
        orderBy: { updatedAt: "desc" },
        take
    });
    return rows.map((row) => {
        const direct = row.channel.dmKey !== null || !row.channel.space;
        return {
            channelId: row.channelId,
            state: row.state as MigratedConversation["state"],
            reason: row.reason,
            name: direct ? null : row.channel.name,
            space: direct ? null : (row.channel.space?.name ?? null),
            cutAt: row.cutAt?.toISOString() ?? null,
            canRollBack: row.state === "cut" && Boolean(row.cutAt && row.cutAt >= since)
        };
    });
}
