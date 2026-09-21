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
import { driveShare } from "@/lib/chat/drive-share";
import {
    AttachRefused,
    fileFromDrive,
    referenceFromDrive
} from "@/lib/attachments/from-elsewhere";
import { ChatAccessError, requirePostable } from "@/lib/chat/access";
import {
    AttachmentStorageError,
    borrowedAttachment,
    storeAttachment,
    type StoredAttachment
} from "@/lib/chat/attachments";

/**
 * The Drive files a message is sharing, as the composer lists them.
 *
 * A JSON array of `{ c, p }` - a storage connection and a path on it - and
 * nothing else: no name, no size, no type. Everything about the file is read from
 * the storage itself under the sender's own authorization, because a client that
 * could name the size of a file it is sharing could name a different one.
 *
 * Silent about anything malformed. This arrives from a browser, and a message
 * with an unreadable reference on it is a message to send without that reference
 * rather than a request to refuse - the composer shows what went on it.
 */
function readBorrowed(raw: FormDataEntryValue | null): { connectionId: string; path: string }[] {
    if (typeof raw !== "string" || raw.trim().length === 0) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: { connectionId: string; path: string }[] = [];
    for (const entry of parsed.slice(0, MOST_BORROWED)) {
        if (typeof entry !== "object" || entry === null) continue;
        const held = entry as Record<string, unknown>;
        const connectionId = typeof held.c === "string" ? held.c.trim() : "";
        const path = typeof held.p === "string" ? held.p.trim() : "";
        if (connectionId.length === 0 || path.length === 0) continue;
        out.push({ connectionId, path });
    }
    return out;
}

/** A ceiling on the list itself, before the rules are consulted: the rules cap
 *  how many files a message carries, and this caps how much work a malformed
 *  request can ask for while that is being worked out. */
const MOST_BORROWED = 50;

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
        // A file from Drive that is not theirs, or is a folder, or would not read.
        // Said in the words `borrowAttachment` chose: they name nothing but the
        // file the sender picked.
        if (caught instanceof AttachRefused) {
            return Response.json({ error: caught.message }, { status: 400 });
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
    // Which of them arrive covered, as a list of indexes: the composer marks
    // them one at a time, because a message is often one picture worth hiding
    // and a sentence that is not.
    const covered = new Set(
        String(form.get("spoilers") ?? "")
            .split(",")
            .map((entry) => Number.parseInt(entry, 10))
            .filter((entry) => Number.isInteger(entry))
    );
    // Files the sender already has in Drive: what travels is where to find them,
    // never the bytes. The browser downloading a file out of one screen of
    // Polaris so it can upload it into another was the whole of what this
    // replaces, and it is why the ceiling used to refuse a file the Drive was
    // holding perfectly well.
    //
    // What happens to them is the instance's choice and it is made here, not in
    // the composer: copied into the conversation's own store (the default, read
    // from the storage by this server), or left where they are and pointed at.
    const borrowed = readBorrowed(form.get("borrowed"));
    const share = borrowed.length > 0 ? await driveShare() : "copy";
    if (files.length === 0 && borrowed.length === 0 && !fields.data.body) {
        return Response.json({ error: "Write something, or attach a file" }, { status: 400 });
    }
    // Whether this account may put files in a conversation at all, which is a
    // grant rather than a rule: the rules below are the instance's ceiling for
    // everybody, and this is one account's standing. Asked before a byte is
    // read off the request.
    if ((files.length > 0 || borrowed.length > 0) && !(await can(user.id, "chat.attach"))) {
        return Response.json(
            { error: "You are not allowed to send files here" },
            { status: 403 }
        );
    }
    // How many files and how big is the instance's decision, and it is answered
    // per kind of conversation: an operator may reasonably allow a screenshot in
    // a channel and nothing at all in a direct message.
    const rules = await rulesForChannel(channelId);
    if ((files.length > 0 || borrowed.length > 0) && rules.maxAttachments === 0) {
        return Response.json({ error: "Files cannot be sent here" }, { status: 400 });
    }
    if (files.length + borrowed.length > rules.maxAttachments) {
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
                    await posterBytes(posters[at]),
                    covered.has(at)
                )
            );
        }
        // After the uploads and in the order they were listed, so the message
        // carries them in the order the composer showed.
        for (const [at, reference] of borrowed.entries()) {
            const spoiler = covered.has(files.length + at);
            stored.push(
                share === "link"
                    ? borrowedAttachment(
                          await referenceFromDrive(
                              user.id,
                              reference.connectionId,
                              reference.path
                          ),
                          spoiler
                      )
                    : // A copy, made where the bytes already are. The ceiling is
                      // applied by the read itself, so a file too big to store is
                      // refused in the words the reader needs rather than after a
                      // download nobody watched.
                      await storeAttachment(
                          channelId,
                          await fileFromDrive(
                              user.id,
                              reference.connectionId,
                              reference.path,
                              biggest
                          ),
                          undefined,
                          null,
                          spoiler
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
    // Never a borrowed one. Nothing was written for it - what was stored is where
    // to find somebody's own file - so "clean up what this send wrote" would
    // reach into their Drive and delete it because a message failed to send.
    if (file.borrowed) return;
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
