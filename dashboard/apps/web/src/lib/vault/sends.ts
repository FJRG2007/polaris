/**
 * Sends: something out of the vault, handed to somebody who has no vault.
 *
 * The same idea as a sealed snippet, reached from the other side. The Send's own
 * key never touches the server - it rides in the fragment of the link, which a
 * browser does not send - so what is stored here is a name, a payload and a set
 * of limits, all of them unreadable.
 *
 * Every limit is enforced on the server, on each access, because the page that
 * shows a Send is a page a stranger controls: the view cap, the expiry, the
 * deletion date and the optional password are the whole product.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import type { SendInput } from "@polaris/core";
import { bumpRevision } from "@/lib/vault/account";
import { deleteVaultBlob } from "@/lib/vault/blobs";
import { generateToken } from "@polaris/core/tokens";
import { hashLinkPassword, verifyLinkPassword } from "@polaris/core/link-password";

/** What lives inside a Send's encrypted document. */
interface SendDocument {
    name: string;
    notes?: string | null;
    text?: { text?: string | null; hidden?: boolean } | null;
    file?: { fileName?: string | null } | null;
}

type SendRow = {
    id: string;
    accessId: string;
    type: number;
    data: string;
    key: string;
    passwordHash: string | null;
    maxAccessCount: number | null;
    accessCount: number;
    expirationDate: Date | null;
    deletionDate: Date;
    disabled: boolean;
    hideEmail: boolean;
    fileSize: bigint | null;
    createdAt: Date;
    revisionDate: Date;
};

function documentOf(row: { data: string }): SendDocument {
    try {
        return JSON.parse(row.data) as SendDocument;
    } catch {
        return { name: "" };
    }
}

function toDocument(input: SendInput): string {
    return JSON.stringify({
        name: input.name,
        notes: input.notes ?? null,
        text: input.text ?? null,
        file: input.file ? { fileName: input.file.fileName ?? null } : null
    } satisfies SendDocument);
}

/** One Send, as its owner's client reads it. */
export function toSendResponse(row: SendRow): Record<string, unknown> {
    const document = documentOf(row);
    return {
        object: "send",
        id: row.id,
        accessId: row.accessId,
        type: row.type,
        name: document.name,
        notes: document.notes ?? null,
        // The key is the owner's own, wrapped under their vault key - it is how
        // their other devices open the Send they made here.
        key: row.key,
        text: document.text ?? null,
        file:
            row.type === core.SEND_FILE
                ? {
                      id: row.id,
                      fileName: document.file?.fileName ?? null,
                      size: row.fileSize?.toString() ?? "0",
                      sizeName: `${Math.max(1, Math.round(Number(row.fileSize ?? 0n) / 1024))} KB`
                  }
                : null,
        maxAccessCount: row.maxAccessCount,
        accessCount: row.accessCount,
        password: row.passwordHash === null ? null : "",
        disabled: row.disabled,
        hideEmail: row.hideEmail,
        expirationDate: row.expirationDate ? row.expirationDate.toISOString() : null,
        deletionDate: row.deletionDate.toISOString(),
        revisionDate: row.revisionDate.toISOString()
    };
}

const SEND_SELECT = {
    id: true,
    accessId: true,
    type: true,
    data: true,
    key: true,
    passwordHash: true,
    maxAccessCount: true,
    accessCount: true,
    expirationDate: true,
    deletionDate: true,
    disabled: true,
    hideEmail: true,
    fileSize: true,
    createdAt: true,
    revisionDate: true
} as const;

/** Every Send this account still has. */
export async function listSends(userId: string): Promise<Record<string, unknown>[]> {
    const rows = await prisma.vaultSend.findMany({
        where: { userId },
        orderBy: { revisionDate: "desc" },
        select: SEND_SELECT
    });
    return rows.map(toSendResponse);
}

/**
 * Create a Send.
 *
 * The access id is a fresh token rather than the row's own id: the id in a link
 * handed to a stranger should not be a database key, and a token is what every
 * other public link in Polaris uses.
 */
export async function createSend(
    userId: string,
    input: SendInput
): Promise<Record<string, unknown>> {
    const row = await prisma.vaultSend.create({
        data: {
            userId,
            type: input.type,
            data: toDocument(input),
            key: input.key,
            passwordHash: input.password ? await hashLinkPassword(input.password) : null,
            maxAccessCount: input.maxAccessCount ?? null,
            expirationDate: input.expirationDate ?? null,
            deletionDate: input.deletionDate,
            disabled: input.disabled,
            hideEmail: input.hideEmail,
            accessId: generateToken()
        },
        select: SEND_SELECT
    });
    await bumpRevision(userId);
    return toSendResponse(row);
}

/** Rewrite a Send. Owner-scoped; a password of null leaves the old one alone. */
export async function updateSend(
    userId: string,
    sendId: string,
    input: SendInput
): Promise<Record<string, unknown> | null> {
    const owned = await prisma.vaultSend.findFirst({
        where: { id: sendId, userId },
        select: { id: true }
    });
    if (!owned) return null;
    const row = await prisma.vaultSend.update({
        where: { id: sendId },
        data: {
            data: toDocument(input),
            key: input.key,
            ...(input.password ? { passwordHash: await hashLinkPassword(input.password) } : {}),
            maxAccessCount: input.maxAccessCount ?? null,
            expirationDate: input.expirationDate ?? null,
            deletionDate: input.deletionDate,
            disabled: input.disabled,
            hideEmail: input.hideEmail,
            revisionDate: new Date()
        },
        select: SEND_SELECT
    });
    await bumpRevision(userId);
    return toSendResponse(row);
}

/** Take the password off a Send, which is its own request in every client. */
export async function removeSendPassword(
    userId: string,
    sendId: string
): Promise<Record<string, unknown> | null> {
    const { count } = await prisma.vaultSend.updateMany({
        where: { id: sendId, userId },
        data: { passwordHash: null, revisionDate: new Date() }
    });
    if (count === 0) return null;
    await bumpRevision(userId);
    const row = await prisma.vaultSend.findUnique({ where: { id: sendId }, select: SEND_SELECT });
    return row ? toSendResponse(row) : null;
}

/** Delete a Send and whatever file it was holding. */
export async function deleteSend(userId: string, sendId: string): Promise<boolean> {
    const row = await prisma.vaultSend.findFirst({
        where: { id: sendId, userId },
        select: { id: true, storedPath: true }
    });
    if (!row) return false;
    await prisma.vaultSend.delete({ where: { id: sendId } });
    await deleteVaultBlob(row.storedPath);
    await bumpRevision(userId);
    return true;
}

/** Record where a file Send's bytes landed, once they have. */
export async function attachSendFile(
    userId: string,
    sendId: string,
    storedPath: string,
    size: bigint
): Promise<boolean> {
    const { count } = await prisma.vaultSend.updateMany({
        where: { id: sendId, userId },
        data: { storedPath, fileSize: size, revisionDate: new Date() }
    });
    return count === 1;
}

/** Why a Send cannot be served, or the Send. */
export type SendAccess =
    | { ok: true; send: SendRow & { storedPath: string | null }; document: SendDocument }
    | { ok: false; reason: "not_found" | "expired" | "exhausted" | "disabled" | "password" };

/**
 * Open a Send from its public link.
 *
 * The view is counted here, in the same statement that checks the cap, so two
 * people opening the last view of a Send at once cannot both be served. A Send
 * past its deletion date answers as if it were never there: it is about to be
 * swept, and telling a stranger that it existed says more than it should.
 */
export async function accessSend(accessId: string, password?: string): Promise<SendAccess> {
    const send = await prisma.vaultSend.findUnique({
        where: { accessId },
        select: { ...SEND_SELECT, storedPath: true }
    });
    if (!send) return { ok: false, reason: "not_found" };

    const now = Date.now();
    if (send.deletionDate.getTime() <= now) return { ok: false, reason: "not_found" };
    if (send.disabled) return { ok: false, reason: "disabled" };
    if (send.expirationDate && send.expirationDate.getTime() <= now) {
        return { ok: false, reason: "expired" };
    }
    if (send.passwordHash) {
        if (!password) return { ok: false, reason: "password" };
        if (!(await verifyLinkPassword(password, send.passwordHash))) {
            return { ok: false, reason: "password" };
        }
    }

    if (send.maxAccessCount !== null) {
        const { count } = await prisma.vaultSend.updateMany({
            where: {
                id: send.id,
                maxAccessCount: { gt: prisma.vaultSend.fields.accessCount }
            },
            data: { accessCount: { increment: 1 } }
        });
        if (count !== 1) return { ok: false, reason: "exhausted" };
    } else {
        await prisma.vaultSend.update({
            where: { id: send.id },
            data: { accessCount: { increment: 1 } }
        });
    }

    return { ok: true, send, document: documentOf(send) };
}

/** What a stranger holding the link is shown. Deliberately less than the owner
 *  sees: no counts, no limits, nothing about who made it unless they said so. */
export function toSendAccessResponse(
    send: SendRow,
    document: SendDocument,
    creator: string | null
): Record<string, unknown> {
    return {
        object: "send-access",
        id: send.accessId,
        type: send.type,
        name: document.name,
        text: document.text ?? null,
        file:
            send.type === core.SEND_FILE
                ? {
                      id: send.id,
                      fileName: document.file?.fileName ?? null,
                      size: send.fileSize?.toString() ?? "0",
                      sizeName: `${Math.max(1, Math.round(Number(send.fileSize ?? 0n) / 1024))} KB`
                  }
                : null,
        expirationDate: send.expirationDate ? send.expirationDate.toISOString() : null,
        creatorIdentifier: send.hideEmail ? null : creator
    };
}

/**
 * Remove the Sends whose time is up.
 *
 * A deletion date is a promise, and a promise that only takes effect when
 * somebody happens to open the link is not one. Run from the same sweep that
 * carries out scheduled deletions.
 */
export async function sweepExpiredSends(): Promise<number> {
    const due = await prisma.vaultSend.findMany({
        where: { deletionDate: { lte: new Date() } },
        select: { id: true, userId: true, storedPath: true }
    });
    if (due.length === 0) return 0;
    await prisma.vaultSend.deleteMany({ where: { id: { in: due.map((row) => row.id) } } });
    for (const row of due) await deleteVaultBlob(row.storedPath);
    for (const userId of new Set(due.map((row) => row.userId))) await bumpRevision(userId);
    return due.length;
}
