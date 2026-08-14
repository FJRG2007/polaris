"use server";

/**
 * Text drop-point server actions: opening one, changing its guardrails, closing
 * it, and - at the bottom, deliberately public - the two a stranger reaches, the
 * password gate and the submission itself.
 *
 * The public pair never trusts the page it came from. The drop point is
 * re-resolved by token, every limit is re-read off the row, and the text is
 * re-validated against them, because the form that sent it is entirely under the
 * sender's control.
 */

import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { getSession } from "@/lib/session";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit-service";
import { requirePermission } from "@/lib/session";
import { dymoIpAllowed } from "@/lib/dymo-service";
import { notify } from "@/lib/notifications/dispatch";
import { linkAddressDenial } from "@/lib/link-guards";
import * as textRequests from "@/lib/text-request-service";
import { ensureShareReachability } from "@/lib/public-reach";
import { clientIp, hashForLog } from "@/lib/request-context";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";
import { createTextRequestSchema, submitTextSchema, updateTextRequestSchema } from "@polaris/core";

/** Attempts allowed before a public password gate blocks, and the window. */
const UNLOCK_LIMIT = 10;
const UNLOCK_WINDOW_MS = 15 * 60 * 1000;

/** Submissions one address may make in an hour, whatever the drop point allows.
 *  The per-drop-point cap is the owner's rule; this one is the instance's. */
const SUBMIT_LIMIT = 30;
const SUBMIT_WINDOW_MS = 60 * 60 * 1000;

function revalidateDropPoints(requestId?: string): void {
    revalidatePath("/drive/drop-points");
    if (requestId) revalidatePath(`/drive/drop-points/text/${requestId}`);
}

/** Open a text drop point and return its link, shown once at creation. */
export async function createTextRequestAction(
    input: unknown
): Promise<{ id?: string; url?: string; error?: string }> {
    const user = await requirePermission("requests.create");
    const parsed = createTextRequestSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid drop point" };

    const { id, token } = await textRequests.createTextRequest(user.id, parsed.data);
    await recordAudit({
        actorId: user.id,
        action: "text-request.create",
        targetType: "text-request",
        targetId: id,
        metadata: {
            requireLogin: parsed.data.requireLogin,
            hasPassword: Boolean(parsed.data.password),
            maxSubmissions: parsed.data.maxSubmissions ?? null
        }
    });
    await ensureShareReachability();
    revalidateDropPoints();
    const { sharingBaseUrl } = await import("@/lib/domain-service");
    return { id, url: `${await sharingBaseUrl()}/tr/${token}` };
}

/** Change a text drop point's guardrails (owner-scoped). */
export async function updateTextRequestAction(
    requestId: string,
    input: unknown
): Promise<{ error?: string }> {
    const user = await requirePermission("requests.create");
    const parsed = updateTextRequestSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid drop point" };
    await textRequests.updateTextRequest(user.id, requestId, parsed.data);
    await recordAudit({
        actorId: user.id,
        action: "text-request.update",
        targetType: "text-request",
        targetId: requestId
    });
    revalidateDropPoints(requestId);
    return {};
}

/** Reveal a text drop point's link again (owner-only). */
export async function revealTextRequestLinkAction(
    requestId: string
): Promise<{ url?: string; error?: string }> {
    const user = await requirePermission("requests.create");
    const url = await textRequests.revealTextRequestLink(user.id, requestId);
    if (!url) return { error: "This drop point's link cannot be recovered. Open a new one." };
    return { url };
}

/** Stop a text drop point accepting anything (owner-scoped). */
export async function revokeTextRequestAction(requestId: string): Promise<void> {
    const user = await requirePermission("requests.create");
    await textRequests.revokeTextRequest(user.id, requestId);
    await recordAudit({
        actorId: user.id,
        action: "text-request.revoke",
        targetType: "text-request",
        targetId: requestId
    });
    revalidateDropPoints(requestId);
}

/** Re-open a closed text drop point (owner-scoped). */
export async function reopenTextRequestAction(requestId: string): Promise<void> {
    const user = await requirePermission("requests.create");
    await textRequests.reopenTextRequest(user.id, requestId);
    await recordAudit({
        actorId: user.id,
        action: "text-request.reopen",
        targetType: "text-request",
        targetId: requestId
    });
    revalidateDropPoints(requestId);
}

/** Delete a text drop point. What it collected stays in the owner's snippets. */
export async function deleteTextRequestAction(requestId: string): Promise<{ error?: string }> {
    const user = await requirePermission("requests.create");
    if (!(await textRequests.deleteTextRequest(user.id, requestId))) {
        return { error: "This drop point is not yours." };
    }
    await recordAudit({
        actorId: user.id,
        action: "text-request.delete",
        targetType: "text-request",
        targetId: requestId
    });
    revalidateDropPoints();
    return {};
}

/**
 * Public: verify a text drop point's password and set the unlock cookie. Same
 * shape, cap and deliberately generic answer as every other link gate.
 */
export async function unlockTextRequestAction(
    token: string,
    password: string
): Promise<{ error?: string }> {
    const request = await textRequests.resolveTextRequestByToken(token);
    if (!request) return { error: "This link is not available." };
    if (!textRequests.textRequestUsability(request).ok) {
        return { error: "This link is no longer available." };
    }

    const limitKey = `textdrop-unlock:${request.id}:${hashForLog(await clientIp()) ?? "unknown"}`;
    if (!(await rateLimit(limitKey, UNLOCK_LIMIT, UNLOCK_WINDOW_MS)).ok) {
        return { error: "Too many attempts. Please wait a few minutes and try again." };
    }
    if (!(await textRequests.verifyTextRequestPassword(request.passwordHash, password))) {
        return { error: "Incorrect password." };
    }

    await resetRateLimit(limitKey);
    const env = loadEnv();
    const store = await cookies();
    store.set(
        textRequests.textRequestUnlockCookie(request.id),
        textRequests.signTextRequestUnlock(request.id, env.POLARIS_AUTH_SECRET),
        {
            httpOnly: true,
            sameSite: "lax",
            secure: env.POLARIS_SECURE_COOKIES,
            path: "/",
            maxAge: 60 * 60 * 12
        }
    );
    return {};
}

/**
 * Public: send text to a drop point.
 *
 * Runs the full gate again rather than trusting that the page did: the drop
 * point must be open, the address allowed, the sender identified when the owner
 * asked for that, and the password already solved. Only then is the text
 * validated against the drop point's own ceiling and stored.
 */
export async function submitTextAction(
    token: string,
    input: unknown
): Promise<{ ok?: true; error?: string }> {
    const request = await textRequests.resolveTextRequestByToken(token);
    if (!request) return { error: "This link is not available." };

    const usable = textRequests.textRequestUsability(request);
    if (!usable.ok) {
        return {
            error:
                usable.reason === "scheduled"
                    ? "This drop point is not open yet."
                    : "This drop point is closed."
        };
    }

    const ip = await clientIp();
    const ipHash = hashForLog(ip);
    if (await linkAddressDenial(request, ip)) {
        return { error: "This drop point is not available from your network." };
    }
    if (!(await dymoIpAllowed(ip)).allowed) {
        return { error: "This drop point is not available from your network." };
    }

    const session = await getSession();
    const userId = session?.user?.id ?? null;
    if (request.requireLogin && !userId) return { error: "Sign in to send this." };
    if (!(await textRequests.textRequestUserAllowed(request.allowedUsers, userId))) {
        return { error: "This drop point does not accept submissions from your account." };
    }
    if (request.passwordHash) {
        const cookieValue = (await cookies()).get(
            textRequests.textRequestUnlockCookie(request.id)
        )?.value;
        if (
            !textRequests.verifyTextRequestUnlock(
                request.id,
                cookieValue,
                loadEnv().POLARIS_AUTH_SECRET
            )
        ) {
            return { error: "This link is protected." };
        }
    }

    if (!(await rateLimit(`textdrop-submit:${ipHash ?? "unknown"}`, SUBMIT_LIMIT, SUBMIT_WINDOW_MS)).ok) {
        return { error: "Too many submissions from here. Try again later." };
    }

    const parsed = submitTextSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid submission" };

    const result = await textRequests.submitText(request, parsed.data, {
        userId,
        ipHash: ipHash ?? null
    });
    if (!result.ok) {
        return {
            error:
                result.reason === "too_long"
                    ? `This is longer than the ${request.maxLength.toLocaleString()} characters this drop point accepts.`
                    : result.reason === "full"
                      ? "This drop point has taken everything it was going to."
                      : "This drop point does not accept sealed submissions."
        };
    }

    await notify({
        userId: request.ownerId,
        event: "drive.dropPoint.received",
        title: `Something arrived at "${request.title}"`,
        body: parsed.data.name,
        href: `/drive/snippets/${result.snippetId}`
    });
    revalidateDropPoints(request.id);
    return { ok: true };
}
