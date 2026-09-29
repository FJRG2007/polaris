/**
 * Reading a conversation up to a message, from a notice's "Mark as read".
 *
 * A route rather than the action the chat screen uses, because the press can
 * arrive with no Polaris page open at all: a browser's notice is handled by the
 * service worker, which can make a request but cannot call an action. The page
 * and the desktop app use it too, so the button does the same thing wherever it
 * was pressed. It ends in the same `markRead` as scrolling a conversation does.
 */

import { z } from "zod";
import { getTranslations } from "@/lib/i18n/request";
import * as core from "@polaris/core";
import { markRead } from "@/lib/chat/messages";
import { apiPermission } from "@/lib/api-session";
import { ChatAccessError } from "@/lib/chat/access";

export const runtime = "nodejs";

const bodySchema = z.object({ messageId: z.string().uuid() });

export async function POST(
    request: Request,
    { params }: { params: Promise<{ channelId: string }> }
): Promise<Response> {
    const user = await apiPermission("chat.use");
    if (user instanceof Response) return user;
    // JSON only: a form posted from another site cannot be one, so a page
    // elsewhere cannot mark somebody's conversations read for them.
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
        // i18n-ignore: a protocol answer to a request no screen sends; nobody reads it
        return Response.json({ error: "Send JSON" }, { status: 415 });
    }
    const { channelId } = await params;
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: (await getTranslations("chat"))("errors.notRead") }, { status: 400 });
    }
    const parsed = core.chatMarkReadSchema.safeParse({
        channelId,
        messageId: bodySchema.safeParse(body).data?.messageId
    });
    if (!parsed.success) return Response.json({ error: (await getTranslations("chat"))("errors.notAMessage") }, { status: 400 });
    try {
        await markRead({ id: user.id }, parsed.data);
    } catch (caught) {
        if (caught instanceof ChatAccessError) {
            return Response.json({ error: caught.message }, { status: 403 });
        }
        throw caught;
    }
    return new Response(null, { status: 204 });
}
