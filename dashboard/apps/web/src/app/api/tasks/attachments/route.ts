/**
 * Uploading a file onto a task.
 *
 * A route rather than a server action, for the same reason Drive uses one: an
 * action buffers the whole body in memory before it runs, which turns a phone
 * video into an out-of-memory crash. Here the request body is piped straight
 * into whichever storage the instance keeps uploads on.
 */

import { requireTask } from "@/lib/tasks/access";
import { apiPermission } from "@/lib/api-session";

import { TaskAccessError } from "@/lib/tasks/access";
import { publishTaskChange } from "@/lib/tasks/live";
import { storeAttachment, uploadLimit } from "@/lib/tasks/attachment-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const user = await apiPermission("tasks.manage");
    if (user instanceof Response) return user;

    const url = new URL(request.url);
    const taskId = url.searchParams.get("task");
    const name = url.searchParams.get("name");
    // The comment it was sent with, when it came from the thread's composer
    // rather than from the Files list. Not trusted to say which task: the task
    // is its own parameter and is what the access check runs on.
    const commentId = url.searchParams.get("comment");
    if (!taskId || !name) return new Response("Missing parameters", { status: 400 });
    if (!request.body) return new Response("Empty body", { status: 400 });

    let spaceId: string;
    try {
        ({ spaceId } = await requireTask({ id: user.id, isAdmin: user.isAdmin }, taskId, "member"));
    } catch (caught) {
        if (caught instanceof TaskAccessError) return new Response("Forbidden", { status: 403 });
        throw caught;
    }

    // Content-Length is a claim, not a promise, so it is only used to refuse the
    // obviously-too-big before reading anything. The real size is whatever the
    // storage reports once the bytes have landed.
    const limit = await uploadLimit();
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > limit) {
        return new Response(`That file is over the ${Math.round(limit / (1024 * 1024))} MB limit`, { status: 413 });
    }

    try {
        const attachment = await storeAttachment({
            taskId,
            uploadedById: user.id,
            name: decodeURIComponent(name),
            mime: request.headers.get("content-type") || "application/octet-stream",
            size: declared,
            body: request.body,
            commentId
        });
        // The uploader's own screen already redraws from the response; this is
        // for everybody else looking at the same task.
        publishTaskChange({ spaceId, actorId: user.id });
        return Response.json({ attachment });
    } catch (error) {
        // The reason is for the operator's log; the uploader gets a sentence they
        // can act on, without the storage layer's paths in it.
        console.error("tasks: attachment upload failed:", error);
        return new Response("Could not store that file", { status: 502 });
    }
}
