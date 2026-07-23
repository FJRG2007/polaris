/**
 * Uploader self-service delete. Lets whoever submitted a file remove it, when the
 * drop point allows self-deletes and any time window has not elapsed. Two ways to
 * prove ownership: a signed-in account that matches the submission, or the signed
 * per-file delete token handed back at upload (stored in that browser). No session
 * is required for the token path, so anonymous uploads are covered. Node runtime.
 */

import { loadEnv } from "@polaris/config";
import { uploaderDeleteAllowed } from "@polaris/core";
import { getSession } from "@/lib/session";
import {
    deleteSubmission,
    getSubmission,
    resolveFileRequestByToken,
    verifySubmissionDelete
} from "@/lib/file-request-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ token: string; id: string }> }
): Promise<Response> {
    const { token, id } = await params;
    const fileRequest = await resolveFileRequestByToken(token);
    if (!fileRequest) return new Response("Not found", { status: 404 });
    if (!fileRequest.allowUploaderDelete) return new Response("deletes_disabled", { status: 403 });

    const submission = await getSubmission(fileRequest.id, id);
    if (!submission) return new Response("Not found", { status: 404 });

    // Time window (when set): only deletable for N seconds after the upload.
    if (
        !uploaderDeleteAllowed({
            allow: true,
            windowSeconds: fileRequest.uploaderDeleteWindowSeconds ?? null,
            uploadedAt: submission.at
        })
    ) {
        return new Response("window_closed", { status: 403 });
    }

    // Authorize: the signed-in uploader who submitted it, or a valid delete token.
    const session = await getSession();
    const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
    const byAccount =
        submission.submittedByUserId !== null && submission.submittedByUserId === userId;
    const presentedToken = request.headers.get("x-delete-token") ?? undefined;
    const byToken = verifySubmissionDelete(
        submission.id,
        presentedToken,
        loadEnv().POLARIS_AUTH_SECRET
    );
    if (!byAccount && !byToken) return new Response("forbidden", { status: 403 });

    await deleteSubmission(fileRequest.id, submission.id);
    return new Response(null, { status: 204 });
}
