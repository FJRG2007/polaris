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
import { apiPermission } from "@/lib/api-session";
import { can } from "@polaris/auth";
import * as core from "@polaris/core";
import { send } from "@/lib/chat/messages";

import { rulesForChannel } from "@/lib/chat/rules";
import { ChatAccessError, requirePostable } from "@/lib/chat/access";
import {
    AttachmentStorageError,
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
    parentId: z.string().uuid().nullable(),
    replyToId: z.string().uuid().nullable()
});

/** How long each file plays for and what it looks like, by position. */
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

/** The field as it arrives, or nothing at all - a message with no recording in
 *  it does not send one, and a malformed one is treated as none rather than as a
 *  reason to refuse the message. */
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

    // What the browser measured while recording, one entry per file in the same
    // order. Optional, absent for every ordinary attachment, and checked again
    // where it is stored - this is a number and a string from a client, and the
    // fact that they are only ever drawn is what makes checking them matter.
    const sounds = soundsSchema.safeParse(readSounds(form.get("sounds")));

    const fields = fieldsSchema.safeParse({
        body: String(form.get("body") ?? ""),
        parentId: form.get("parentId") ? String(form.get("parentId")) : null,
        replyToId: form.get("replyToId") ? String(form.get("replyToId")) : null
    });
    if (!fields.success) return Response.json({ error: "That could not be sent" }, { status: 400 });

    const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
    // One still per file, in the same order, with an empty one standing in for
    // everything that is not a video. Never required: a message whose thumbnails
    // did not arrive is a message.
    const posters = form.getAll("posters").filter((entry): entry is File => entry instanceof File);
    if (files.length === 0 && !fields.data.body) {
        return Response.json({ error: "Write something, or attach a file" }, { status: 400 });
    }
    // Whether this account may put files in a conversation at all, which is a
    // grant rather than a rule: the rules below are the instance's ceiling for
    // everybody, and this is one account's standing. Asked before a byte is
    // read off the request.
    if (files.length > 0 && !(await can(user.id, "chat.attach"))) {
        return Response.json(
            { error: "You are not allowed to send files here" },
            { status: 403 }
        );
    }
    // How many files and how big is the instance's decision, and it is answered
    // per kind of conversation: an operator may reasonably allow a screenshot in
    // a channel and nothing at all in a direct message.
    const rules = await rulesForChannel(channelId);
    if (files.length > 0 && rules.maxAttachments === 0) {
        return Response.json({ error: "Files cannot be sent here" }, { status: 400 });
    }
    if (files.length > rules.maxAttachments) {
        return Response.json(
            { error: `That is more than ${rules.maxAttachments} files` },
            { status: 400 }
        );
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
            stored,
            fields.data.replyToId ? { messageId: fields.data.replyToId, forwarded: false } : null
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
        // Said as what it is. "That could not be sent" for a storage that took
        // the file and lost it sends whoever reads it looking at the browser, at
        // the network and at the message - anywhere but at the disk.
        if (caught instanceof AttachmentStorageError) {
            console.error(caught);
            return Response.json({ error: caught.message }, { status: 502 });
        }
        console.error(caught);
        // To an administrator, what actually threw. "That could not be sent" is
        // the right thing to tell somebody who cannot act on it and the wrong
        // thing to tell the one person who can - it is their instance, and the
        // sentence they need is in a log they should not have to go and find.
        const detail = caught instanceof Error ? caught.message : String(caught);
        return Response.json(
            { error: user.isAdmin ? `That could not be sent: ${detail}` : "That could not be sent" },
            { status: 500 }
        );
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
