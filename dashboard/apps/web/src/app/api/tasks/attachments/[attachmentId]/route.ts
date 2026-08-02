/**
 * Reading a file attached to a task.
 *
 * Authorization goes through the task, not through the storage: whoever may see
 * the task may see what is stapled to it, and nobody else - the id in the URL is
 * not the permission. Images and video are served inline so a screenshot shows
 * on the task; everything else downloads.
 */

import { requirePermission } from "@/lib/session";
import { requireTask, TaskAccessError } from "@/lib/tasks/access";
import { attachmentTaskId, readAttachment } from "@/lib/tasks/attachment-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ attachmentId: string }> }
): Promise<Response> {
    const { attachmentId } = await params;
    const user = await requirePermission("tasks.read");

    const taskId = await attachmentTaskId(attachmentId);
    if (!taskId) return new Response("Not found", { status: 404 });
    try {
        await requireTask({ id: user.id, isAdmin: user.isAdmin }, taskId, "guest");
    } catch (caught) {
        // The same answer whether the task is missing or forbidden: confirming
        // that an id exists is itself something worth not saying.
        if (caught instanceof TaskAccessError) return new Response("Not found", { status: 404 });
        throw caught;
    }

    const file = await readAttachment(attachmentId);
    if (!file) return new Response("Not found", { status: 404 });

    const inline = file.mime.startsWith("image/") || file.mime.startsWith("video/") || file.mime === "application/pdf";
    return new Response(file.body, {
        headers: {
            "Content-Type": file.mime,
            "Content-Length": String(file.size),
            // The name is quoted and stripped of anything that could end the
            // header early; a file name is user input like any other.
            "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${file.name.replace(/["\\\r\n]/g, "")}"`,
            "Cache-Control": "private, max-age=300"
        }
    });
}
