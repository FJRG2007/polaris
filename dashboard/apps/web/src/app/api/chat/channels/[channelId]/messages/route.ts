/**
 * Sending a message with files on it.
 *
 * A route rather than a server action because the body is a file, and because
 * the bytes have to be written before the message exists - a message that landed
 * without its attachments would be a message nobody could make sense of.
 *
 * Plain text still goes through the action: it is faster, it is optimistic, and
 * it is what almost every message is. This is the path for the ones that carry
 * something, and it ends in exactly the same `send` so nothing about a message
 * depends on which door it came through.
 *
 * Files are written first and the message second. If the write of the message
 * fails, the bytes are removed again rather than left behind - an orphan on a
 * NAS is somebody's disk quietly filling up.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { send } from "@/lib/chat/messages";
import { requirePermission } from "@/lib/session";
import { ChatAccessError, requirePostable } from "@/lib/chat/access";
import {
    MAX_ATTACHMENTS,
    MAX_ATTACHMENT_BYTES,
    storeAttachment,
    type StoredAttachment
} from "@/lib/chat/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fieldsSchema = z.object({
    // Empty is allowed here and nowhere else: a message that is only a file is a
    // message, and forcing somebody to type "here" first is a tax on the common
    // case of sending a screenshot.
    body: z.string().trim().max(core.MAX_CHAT_MESSAGE),
    parentId: z.string().uuid().nullable()
});

export async function POST(
    request: Request,
    { params }: { params: Promise<{ channelId: string }> }
): Promise<Response> {
    const user = await requirePermission("chat.use");
    const { channelId } = await params;

    try {
        await requirePostable({ id: user.id }, channelId);
    } catch (caught) {
        if (caught instanceof ChatAccessError) {
            return Response.json({ error: caught.message }, { status: 403 });
        }
        throw caught;
    }

    let form: FormData;
    try {
        form = await request.formData();
    } catch {
        return Response.json({ error: "That could not be read" }, { status: 400 });
    }

    const fields = fieldsSchema.safeParse({
        body: String(form.get("body") ?? ""),
        parentId: form.get("parentId") ? String(form.get("parentId")) : null
    });
    if (!fields.success) return Response.json({ error: "That could not be sent" }, { status: 400 });

    const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
    if (files.length === 0 && !fields.data.body) {
        return Response.json({ error: "Write something, or attach a file" }, { status: 400 });
    }
    if (files.length > MAX_ATTACHMENTS) {
        return Response.json(
            { error: `That is more than ${MAX_ATTACHMENTS} files` },
            { status: 400 }
        );
    }
    for (const file of files) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
            return Response.json({ error: `${file.name} is too big` }, { status: 400 });
        }
    }

    const stored: StoredAttachment[] = [];
    try {
        for (const file of files) {
            stored.push(
                await storeAttachment(channelId, {
                    name: file.name,
                    type: file.type,
                    bytes: new Uint8Array(await file.arrayBuffer())
                })
            );
        }

        const id = await send(
            { id: user.id },
            {
                channelId,
                // The schema behind the action refuses an empty body, and a
                // message that is only a file has one. What it stands for is
                // said by the attachment beneath it.
                body: fields.data.body || " ",
                parentId: fields.data.parentId
            },
            stored
        );
        return Response.json({ id });
    } catch (caught) {
        // Nothing points at these bytes now. Best effort: a file left behind is
        // worse than a failed send, and a failed cleanup must not replace the
        // error that caused it.
        await Promise.all(
            stored.map((file) => removeQuietly(file))
        );
        if (caught instanceof ChatAccessError) {
            return Response.json({ error: caught.message }, { status: 403 });
        }
        console.error(caught);
        return Response.json({ error: "That could not be sent" }, { status: 500 });
    }
}

async function removeQuietly(file: StoredAttachment): Promise<void> {
    const { driverForTarget, LOCAL_TARGET } = await import("@/lib/storage-target");
    const driver = await driverForTarget(file.connectionId ?? LOCAL_TARGET, "chat").catch(
        () => null
    );
    if (!driver) return;
    try {
        await driver.delete(file.path);
    } catch {
        // Already gone, or unreachable. Either way there is nothing further to do.
    } finally {
        await driver.dispose().catch(() => undefined);
    }
}
