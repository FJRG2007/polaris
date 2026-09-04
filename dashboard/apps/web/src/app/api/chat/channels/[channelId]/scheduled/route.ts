/**
 * Scheduling a message that carries files.
 *
 * The same door as the one live messages with files come through, and for the
 * same reason: the body is a file, and the bytes have to be written before
 * anything can point at them. Here it matters more than there - the message goes
 * hours from now, and the machine that has the bytes is a laptop that will be
 * shut. Written now, sent later, from storage.
 *
 * Plain text goes through the action instead. It is faster, it needs no
 * multipart, and it is what most scheduled messages are.
 *
 * Files first, row second, and the bytes are removed again if the row fails -
 * an orphan on a NAS is somebody's disk quietly filling up.
 */

import { z } from "zod";
import { apiPermission } from "@/lib/api-session";
import { can } from "@polaris/auth";
import * as core from "@polaris/core";

import { rulesForChannel } from "@/lib/chat/rules";
import { scheduleMessage } from "@/lib/chat/scheduled";
import { ChatAccessError, requirePostable } from "@/lib/chat/access";
import {
    AttachmentStorageError,
    removeStoredFiles,
    storeAttachment,
    type StoredAttachment
} from "@/lib/chat/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fieldsSchema = z.object({
    body: z.string().trim().max(core.MAX_CHAT_MESSAGE),
    parentId: z.string().uuid().nullable(),
    replyToId: z.string().uuid().nullable(),
    sendAt: z.string().datetime()
});

/** How long each recording plays for and what it looks like, by position - the
 *  same field the live route takes, since a scheduled voice message is a voice
 *  message. */
const soundsSchema = z
    .array(
        z
            .object({
                durationMs: z.number().int().positive().max(60 * 60 * 1000).nullable(),
                waveform: z.string().regex(/^[0-9]{1,64}$/).nullable()
            })
            .partial()
    )
    .max(core.CHAT_ATTACHMENT_COUNT_CEILING)
    .default([]);

function readSounds(field: FormDataEntryValue | null): unknown {
    if (typeof field !== "string" || !field) return [];
    try {
        return JSON.parse(field);
    } catch {
        return [];
    }
}

/**
 * The still that came with one file, if any came at all.
 *
 * An empty entry is what stands in for a file that is not a video, so the two
 * lists can be walked together; anything that is not a picture is ignored rather
 * than refused, since it is a decoration and the message is not.
 */
async function posterBytes(entry: File | undefined): Promise<Uint8Array | null> {
    if (!entry || entry.size === 0) return null;
    if (!entry.type.startsWith("image/")) return null;
    return new Uint8Array(await entry.arrayBuffer());
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ channelId: string }> }
): Promise<Response> {
    const user = await apiPermission("chat.use");
    if (user instanceof Response) return user;
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

    const sounds = soundsSchema.safeParse(readSounds(form.get("sounds")));
    const fields = fieldsSchema.safeParse({
        body: String(form.get("body") ?? ""),
        parentId: form.get("parentId") ? String(form.get("parentId")) : null,
        replyToId: form.get("replyToId") ? String(form.get("replyToId")) : null,
        sendAt: String(form.get("sendAt") ?? "")
    });
    if (!fields.success) {
        return Response.json({ error: "That could not be scheduled" }, { status: 400 });
    }
    // The window, before a byte is read: a moment in the past is a message that
    // goes the second it is written, and one in the far future never goes at all.
    const refusal = core.scheduleRefusal(new Date(fields.data.sendAt));
    if (refusal) return Response.json({ error: refusal }, { status: 400 });

    const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
    // One still per file, in the same order, with an empty one standing in for
    // everything that is not a video. Never required: a message whose thumbnails
    // did not arrive is a message.
    const posters = form.getAll("posters").filter((entry): entry is File => entry instanceof File);
    if (files.length === 0 && !fields.data.body) {
        return Response.json({ error: "Write something, or attach a file" }, { status: 400 });
    }
    if (files.length > 0 && !(await can(user.id, "chat.attach"))) {
        return Response.json({ error: "You are not allowed to send files here" }, { status: 403 });
    }

    const rules = await rulesForChannel(channelId);
    if (files.length > 0 && rules.maxAttachments === 0) {
        return Response.json({ error: "Files cannot be sent here" }, { status: 400 });
    }
    if (files.length > rules.maxAttachments) {
        return Response.json({ error: `That is more than ${rules.maxAttachments} files` }, { status: 400 });
    }
    const biggest = rules.maxAttachmentMib * 1024 * 1024;
    for (const file of files) {
        if (file.size > biggest) {
            return Response.json(
                { error: `${file.name} is bigger than ${rules.maxAttachmentMib} MB` },
                { status: 400 }
            );
        }
    }

    const stored: StoredAttachment[] = [];
    try {
        for (const [at, file] of files.entries()) {
            stored.push(
                await storeAttachment(
                    channelId,
                    {
                        name: file.name,
                        type: file.type,
                        bytes: new Uint8Array(await file.arrayBuffer())
                    },
                    sounds.success ? sounds.data[at] : undefined,
                    await posterBytes(posters[at])
                )
            );
        }

        const id = await scheduleMessage(
            { id: user.id },
            {
                channelId,
                body: fields.data.body,
                parentId: fields.data.parentId,
                replyToId: fields.data.replyToId,
                forwarded: false,
                sendAt: fields.data.sendAt
            },
            stored
        );
        return Response.json({ id });
    } catch (caught) {
        // Nothing points at these bytes now.
        await removeStoredFiles(stored).catch(() => undefined);
        if (caught instanceof ChatAccessError) {
            return Response.json({ error: caught.message }, { status: 403 });
        }
        if (caught instanceof AttachmentStorageError) {
            console.error(caught);
            return Response.json({ error: caught.message }, { status: 502 });
        }
        console.error(caught);
        const detail = caught instanceof Error ? caught.message : String(caught);
        return Response.json(
            {
                error: user.isAdmin
                    ? `That could not be scheduled: ${detail}`
                    : "That could not be scheduled"
            },
            { status: 500 }
        );
    }
}
