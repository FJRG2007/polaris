/**
 * One file into a conversation, streamed, before the message that will carry it.
 *
 * A route of its own rather than part of the send, because the point of it is that
 * the bytes never land in this process: `request.body` goes to the storage driver
 * a chunk at a time, and what comes back is an id for the message to name. The
 * send route still takes files in its form for everything small, so nothing that
 * already worked stopped working - but a file measured in gigabytes only gets in
 * through here.
 *
 * Every gate the send applies is applied here, and before a byte is read: this is
 * the door the bytes actually come through, and "checked when the message is sent"
 * would mean anybody could fill the storage and then not send anything.
 *
 * The size limit is the one thing that cannot be settled up front - `content-length`
 * is the sender's own claim - so it is counted through the stream and the write is
 * failed the moment it is passed. That answers 413, which is the one refusal a
 * browser can act on without reading the body.
 */

import { can } from "@polaris/auth";
import { apiPermission } from "@/lib/api-session";
import { rulesForChannel } from "@/lib/chat/rules";
import { StorageRefused } from "@/lib/storage-target";
import { cappedStream, wasTooLarge } from "@/lib/stream-cap";
import { ChatAccessError, requirePostable } from "@/lib/chat/access";
import { discardUpload, stageUpload, UploadRefused } from "@/lib/chat/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(
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

    // This account's standing, then the instance's rules for this kind of
    // conversation. Both before the body is touched.
    if (!(await can(user.id, "chat.attach"))) {
        return Response.json({ error: "You are not allowed to send files here" }, { status: 403 });
    }
    const rules = await rulesForChannel(channelId);
    if (rules.maxAttachments === 0) {
        return Response.json({ error: "Files cannot be sent here" }, { status: 400 });
    }

    const url = new URL(request.url);
    const name = url.searchParams.get("name");
    if (!name) return Response.json({ error: "That file has no name" }, { status: 400 });
    if (!request.body) return Response.json({ error: "That file was empty" }, { status: 400 });

    const biggest = rules.maxAttachmentMib * 1024 * 1024;
    // What the browser says it weighs. Refused here when it is already over the
    // limit, which saves sending the whole file to be told; never trusted as the
    // size, which is why the stream is capped as well.
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > biggest) {
        return Response.json({ error: tooBig(name, rules.maxAttachmentMib) }, { status: 413 });
    }

    try {
        const staged = await stageUpload({
            userId: user.id,
            channelId,
            name,
            contentType: request.headers.get("content-type") ?? "application/octet-stream",
            spoiler: url.searchParams.get("spoiler") === "1",
            body: cappedStream(request.body, biggest),
            declared: Number.isFinite(declared) && declared > 0 ? declared : undefined
        });
        return Response.json(staged);
    } catch (caught) {
        if (wasTooLarge(caught)) {
            return Response.json({ error: tooBig(name, rules.maxAttachmentMib) }, { status: 413 });
        }
        if (caught instanceof UploadRefused) {
            return Response.json({ error: caught.message }, { status: 400 });
        }
        // The storage took it and lost it, or would not take it at all. Said as
        // what it is: "that could not be sent" for a share that is unplugged sends
        // whoever reads it looking at their browser.
        if (caught instanceof StorageRefused) {
            console.error(caught);
            return Response.json({ error: caught.message }, { status: 502 });
        }
        console.error(caught);
        const detail = caught instanceof Error ? caught.message : String(caught);
        return Response.json(
            {
                error: user.isAdmin
                    ? `That file could not be stored: ${detail}`
                    : "That file could not be stored"
            },
            { status: 500 }
        );
    }
}

/**
 * Take a staged file back off.
 *
 * What the X beside a file in the composer reaches. Without it, changing your
 * mind leaves the bytes on the storage until the sweep, which is half a day of
 * disk for a file nobody ever sent.
 */
export async function DELETE(request: Request): Promise<Response> {
    const user = await apiPermission("chat.use");
    if (user instanceof Response) return user;
    const id = new URL(request.url).searchParams.get("id") ?? "";
    // Theirs or nothing, and silent either way: a request to remove a file that is
    // already gone has got what it asked for.
    await discardUpload(user.id, id);
    return Response.json({ ok: true });
}

/** The one sentence a sender can act on, in the units the screen above them uses. */
function tooBig(name: string, mib: number): string {
    return `${name} is bigger than ${mib} MB`;
}
