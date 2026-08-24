/**
 * Putting a file into a call.
 *
 * A route rather than a server action because the body is a file, and because
 * the bytes have to be on storage before the message exists - a line that landed
 * without its picture is a line nobody can make sense of.
 *
 * Words alone still go through the action: it is faster, and it is what nearly
 * every line is. This is the door for the ones that carry something, and it ends
 * in the same `sayInMeeting` so nothing about a line depends on which door it
 * came through.
 *
 * Proved by a seat rather than by a session, like everything else about a call:
 * half the room may have no account, and the person most likely to be handing
 * over a document is the one who arrived on the link.
 */

import { z } from "zod";
import { ChatAccessError } from "@/lib/chat/access";
import { resolveSeat } from "@/lib/chat/meeting-seat";
import { sayInMeeting } from "@/lib/chat/meeting-chat";
import { MAX_MEETING_LINE } from "@/lib/chat/meeting-limits";
import {
    dropStoredFiles,
    storeMeetingFile,
    MAX_MEETING_FILE_BYTES,
    MAX_MEETING_FILES,
    type StoredMeetingFile
} from "@/lib/chat/meeting-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Empty is allowed: a line that is only a picture is a line, and making somebody
// type "here" first is a tax on the commonest thing a call's chat is used for.
const bodySchema = z.string().trim().max(MAX_MEETING_LINE);

/** How big the ceiling reads to a person, for the sentence that refuses a file. */
const MAX_MEETING_FILE_MB = Math.round(MAX_MEETING_FILE_BYTES / (1024 * 1024));

export async function POST(
    request: Request,
    { params }: { params: Promise<{ meetingId: string }> }
): Promise<Response> {
    const { meetingId } = await params;
    const seat = await resolveSeat(meetingId);
    if (!seat) return Response.json({ error: "You are not in that call" }, { status: 403 });
    if (seat.admission !== "admitted") {
        return Response.json({ error: "You are still waiting to be let in" }, { status: 403 });
    }

    let form: FormData;
    try {
        form = await request.formData();
    } catch {
        return Response.json({ error: "That could not be read" }, { status: 400 });
    }

    const body = bodySchema.safeParse(String(form.get("body") ?? ""));
    if (!body.success) return Response.json({ error: "That could not be sent" }, { status: 400 });

    const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
    if (files.length === 0 && !body.data) {
        return Response.json({ error: "Write something, or attach a file" }, { status: 400 });
    }
    if (files.length > MAX_MEETING_FILES) {
        return Response.json(
            { error: `That is more than ${MAX_MEETING_FILES} files` },
            { status: 400 }
        );
    }
    for (const file of files) {
        if (file.size > MAX_MEETING_FILE_BYTES) {
            return Response.json(
                { error: `${file.name} is bigger than ${MAX_MEETING_FILE_MB} MB` },
                { status: 400 }
            );
        }
    }

    const stored: StoredMeetingFile[] = [];
    try {
        for (const file of files) {
            stored.push(
                await storeMeetingFile(meetingId, {
                    name: file.name,
                    type: file.type,
                    bytes: new Uint8Array(await file.arrayBuffer())
                })
            );
        }
        await sayInMeeting(seat, body.data, stored);
        return Response.json({ ok: true });
    } catch (caught) {
        // Nothing points at these bytes now. Best effort, and never allowed to
        // replace the error that caused it: a file left behind on a share is
        // worse than a failed send, but only just.
        await dropStoredFiles(stored);
        if (caught instanceof ChatAccessError) {
            return Response.json({ error: caught.message }, { status: 403 });
        }
        console.error("polaris: a file could not be put into a call:", caught);
        return Response.json({ error: "That could not be sent" }, { status: 500 });
    }
}
