/**
 * Read-only public links to Polar chats. The raw token exists in the URL only:
 * the row keeps its hash for the lookup and an encrypted copy, so the owner can
 * be shown the link again. Revoking deletes the row, and the link answers 404.
 *
 * A link is a snapshot: what was written after it was made is not shown until
 * the owner updates it. Only the words of the conversation are shown - never a
 * tool call or its result, which can carry what the owner's access reached.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { sharingBaseUrl } from "@/lib/domain-service";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { generateToken, hashToken } from "@polaris/core/tokens";

export interface PolarShareLink {
    url: string;
    sharedAt: string;
}

async function linkFor(token: string): Promise<string> {
    return `${await sharingBaseUrl()}/c/${token}`;
}

/** The chat's link, or null when it is not shared. */
export async function polarShareLink(
    userId: string,
    threadId: string
): Promise<PolarShareLink | null> {
    const share = await prisma.polarThreadShare.findFirst({
        where: { threadId, thread: { userId } },
        select: { encryptedToken: true, tokenNonce: true, tokenKeyId: true, sharedAt: true }
    });
    if (!share) return null;
    const token = decryptSecret(
        {
            ciphertext: Buffer.from(share.encryptedToken),
            nonce: Buffer.from(share.tokenNonce),
            keyId: share.tokenKeyId
        },
        loadEnv().POLARIS_MASTER_KEY
    );
    return { url: await linkFor(token), sharedAt: share.sharedAt.toISOString() };
}

/**
 * Shares the chat, or moves an existing link's snapshot to now. The address of
 * an existing link stays the same. Null when the chat is not this person's.
 */
export async function sharePolarThread(
    userId: string,
    threadId: string
): Promise<PolarShareLink | null> {
    const owned = await prisma.polarThread.count({ where: { id: threadId, userId } });
    if (!owned) return null;
    const existing = await prisma.polarThreadShare.findUnique({
        where: { threadId },
        select: { id: true }
    });
    if (existing) {
        await prisma.polarThreadShare.update({
            where: { id: existing.id },
            data: { sharedAt: new Date() }
        });
    } else {
        const token = generateToken();
        const blob = encryptSecret(token, loadEnv().POLARIS_MASTER_KEY);
        await prisma.polarThreadShare.create({
            data: {
                threadId,
                tokenHash: hashToken(token),
                encryptedToken: blob.ciphertext,
                tokenNonce: blob.nonce,
                tokenKeyId: blob.keyId
            }
        });
    }
    return polarShareLink(userId, threadId);
}

/** Stops serving the link. Idempotent; false only when the chat is not theirs. */
export async function revokePolarShare(userId: string, threadId: string): Promise<boolean> {
    const owned = await prisma.polarThread.count({ where: { id: threadId, userId } });
    if (!owned) return false;
    await prisma.polarThreadShare.deleteMany({ where: { threadId } });
    return true;
}

export interface SharedPolarMessage {
    id: string;
    role: "user" | "assistant";
    text: string;
}

export interface SharedPolarThread {
    title: string;
    sharedAt: string;
    messages: SharedPolarMessage[];
}

/** Most messages a shared page reads. */
const SHARED_MOST = 500;

type Row = { id: string; parentId: string | null; role: string; parts: unknown };

function textOf(parts: unknown): string {
    if (!Array.isArray(parts)) return "";
    return parts
        .map((part) =>
            part && typeof part === "object" && (part as { type?: unknown }).type === "text"
                ? String((part as { text?: unknown }).text ?? "")
                : ""
        )
        .join("")
        .trim();
}

/**
 * The conversation as the screen last showed it: from the newest first message,
 * always the newest answer to each one (an edited message's newest version).
 * Rows come oldest first.
 */
export function newestPath<T extends Row>(rows: readonly T[]): T[] {
    const children = new Map<string | null, T[]>();
    const ids = new Set(rows.map((row) => row.id));
    for (const row of rows) {
        const parent = row.parentId && ids.has(row.parentId) ? row.parentId : null;
        children.set(parent, [...(children.get(parent) ?? []), row]);
    }
    const path: T[] = [];
    const seen = new Set<string>();
    let next = children.get(null)?.at(-1);
    while (next && !seen.has(next.id)) {
        seen.add(next.id);
        path.push(next);
        next = children.get(next.id)?.at(-1);
    }
    return path;
}

/** What a public link shows, or null for a token that is not a live link. */
export async function readSharedPolarThread(token: string): Promise<SharedPolarThread | null> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
    const share = await prisma.polarThreadShare.findUnique({
        where: { tokenHash: hashToken(token) },
        select: { sharedAt: true, threadId: true, thread: { select: { title: true } } }
    });
    if (!share) return null;
    const rows = await prisma.polarMessage.findMany({
        where: { threadId: share.threadId, createdAt: { lte: share.sharedAt } },
        select: { id: true, parentId: true, role: true, parts: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: SHARED_MOST
    });
    return {
        title: share.thread.title,
        sharedAt: share.sharedAt.toISOString(),
        messages: newestPath(rows)
            .filter((row) => row.role === "user" || row.role === "assistant")
            .map((row) => ({
                id: row.id,
                role: row.role as "user" | "assistant",
                text: textOf(row.parts)
            }))
            .filter((row) => row.text.length > 0)
    };
}
