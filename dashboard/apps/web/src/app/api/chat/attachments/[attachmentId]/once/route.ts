/**
 * A view-once photo or video, opened by the Polaris phone app.
 *
 * GET hands out a challenge for this reader and this file. POST proves the
 * open - the challenge signed with the phone's own key - records it, and only
 * then streams the bytes, with the timer and the watermark the phone draws.
 * Everything else, a browser included, is turned away by the ordinary route.
 * See `lib/chat/view-once`.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { apiPermission } from "@/lib/api-session";
import { channelAccess } from "@/lib/chat/access";
import { publishChatChange } from "@/lib/chat/live";
import { readerWords } from "@/lib/i18n/reader-words";
import { streamStored } from "@/lib/chat/streamed-file";
import * as history from "@/lib/chat/history-visibility";
import {
    claimViewOnce,
    viewOnceChallenge,
    viewOnceFile,
    ViewOnceRefused,
    watermarkText,
    type ViewOnceFile
} from "@/lib/chat/view-once";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

const proofSchema = z.object({
    challenge: z.string().trim().min(10).max(200),
    publicKey: z.string().trim().min(40).max(400),
    signature: z.string().trim().min(16).max(200)
});

type Reader = { readonly id: string; readonly name?: string | null; readonly username?: string | null };

/** The file, when this reader may open it at all; the same 404 for "not there" and "not yours". */
async function reachable(user: Reader, attachmentId: string): Promise<ViewOnceFile | null> {
    if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) return null;
    const file = await viewOnceFile(attachmentId);
    if (!file) return null;
    if (!(await channelAccess({ id: user.id }, file.message.channelId))) return null;
    if (!(await history.attachmentReadable({ id: user.id }, file.message.channelId, attachmentId))) return null;
    return file;
}

async function refusal(reason: ViewOnceRefused["reason"]): Promise<Response> {
    const words = await readerWords("chat");
    const status = reason === "opened" || reason === "own" ? 409 : reason === "notFound" ? 404 : 403;
    return Response.json({ error: words(`viewOnce.refused.${reason}`) }, { status, headers: NO_STORE });
}

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ attachmentId: string }> }
): Promise<Response> {
    const user = await apiPermission("chat.use");
    if (user instanceof Response) return user;
    const { attachmentId } = await params;
    const file = await reachable(user, attachmentId);
    if (!file) return refusal("notFound");
    if (file.message.authorId === user.id) return refusal("own");
    return Response.json({ challenge: viewOnceChallenge(file.id, user.id) }, { headers: NO_STORE });
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ attachmentId: string }> }
): Promise<Response> {
    const user = await apiPermission("chat.use");
    if (user instanceof Response) return user;
    const { attachmentId } = await params;
    const proof = proofSchema.safeParse(await request.json().catch(() => null));
    if (!proof.success) return refusal("signature");
    const file = await reachable(user, attachmentId);
    if (!file) return refusal("notFound");

    try {
        await claimViewOnce(user.id, file, proof.data);
    } catch (error) {
        if (error instanceof ViewOnceRefused) return refusal(error.reason);
        throw error;
    }
    // The sender's "opened" and every other screen of this reader's, now.
    publishChatChange({
        channelId: file.message.channelId,
        kind: "posted",
        actorId: user.id,
        messageIds: [file.message.id]
    });

    const opened = await streamStored(file, null, `view-once ${attachmentId}`);
    if (!opened.ok) {
        // Recorded as opened and then not delivered: the one open is given back,
        // since nobody saw anything.
        await prisma.chatAttachmentOpen
            .delete({ where: { attachmentId_userId: { attachmentId: file.id, userId: user.id } } })
            .catch(() => undefined);
        return Response.json(
            { error: (await readerWords("chat"))("errors.attachmentGone") },
            { status: 410, headers: NO_STORE }
        );
    }
    const viewer = await prisma.user.findUnique({ where: { id: user.id }, select: { name: true, username: true } });
    return new Response(opened.body, {
        headers: {
            ...NO_STORE,
            "Content-Type": file.contentType,
            "Content-Disposition": "inline",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "X-Polaris-View-Seconds": file.viewSeconds === null ? "" : String(file.viewSeconds),
            "X-Polaris-Watermark": encodeURIComponent(watermarkText(viewer?.name || viewer?.username || ""))
        }
    });
}
