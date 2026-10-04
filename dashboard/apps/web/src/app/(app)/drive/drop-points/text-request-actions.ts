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

import { z } from "zod";
import { cookies } from "next/headers";
import { getTranslations } from "@/lib/i18n/request";
import { loadEnv } from "@polaris/config";
import { getSession } from "@/lib/session";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit-service";
import { requirePermission } from "@/lib/session";
import { dymoIpAllowed } from "@/lib/dymo-service";
import { notify } from "@/lib/notifications/dispatch";
import { DEFAULT_LOCALE } from "@polaris/core";
import { translatorFor } from "@/lib/i18n/translate";
import { getUserLocale } from "@/lib/i18n/locale-service";
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
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? (await getTranslations("drive"))("errors.invalidDropPoint") };

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
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? (await getTranslations("drive"))("errors.invalidDropPoint") };
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
    if (!url) return { error: (await getTranslations("drive"))("errors.linkUnrecoverable") };
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
        return { error: (await getTranslations("drive"))("errors.dropPointNotYours") };
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

const bulkTextDeleteSchema = z.array(z.string().uuid()).min(1).max(500);

/**
 * Delete several text drop points at once. What each collected stays in the
 * owner's snippets, as it does for one. Answers which went and which did not.
 */
export async function deleteTextRequestsAction(
    requestIds: string[]
): Promise<{ deleted: string[]; failed: { id: string; error: string }[]; error?: string }> {
    const user = await requirePermission("requests.create");
    const t = await getTranslations("drive");
    const parsed = bulkTextDeleteSchema.safeParse(requestIds);
    if (!parsed.success) return { deleted: [], failed: [], error: t("errors.dropPointNotYours") };
    const deleted: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of new Set(parsed.data)) {
        if (!(await textRequests.deleteTextRequest(user.id, id))) {
            failed.push({ id, error: t("errors.dropPointNotYours") });
            continue;
        }
        deleted.push(id);
        await recordAudit({
            actorId: user.id,
            action: "text-request.delete",
            targetType: "text-request",
            targetId: id
        });
    }
    if (deleted.length > 0) revalidateDropPoints();
    return { deleted, failed };
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
    if (!request) return { error: (await getTranslations("drive"))("errors.linkUnavailable") };
    if (!textRequests.textRequestUsability(request).ok) {
        return { error: (await getTranslations("drive"))("errors.linkGone") };
    }

    const limitKey = `textdrop-unlock:${request.id}:${hashForLog(await clientIp()) ?? "unknown"}`;
    if (!(await rateLimit(limitKey, UNLOCK_LIMIT, UNLOCK_WINDOW_MS)).ok) {
        return { error: (await getTranslations("drive"))("errors.tooManyAttempts") };
    }
    if (!(await textRequests.verifyTextRequestPassword(request.passwordHash, password))) {
        return { error: (await getTranslations("drive"))("errors.wrongPassword") };
    }

    await resetRateLimit(limitKey);
    const env = loadEnv();
    const store = await cookies();
    store.set(
        textRequests.textRequestUnlockCookie(request.id),
        textRequests.signTextRequestUnlock(
            request.id,
            request.passwordHash,
            env.POLARIS_AUTH_SECRET
        ),
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
    if (!request) return { error: (await getTranslations("drive"))("errors.linkUnavailable") };

    const usable = textRequests.textRequestUsability(request);
    if (!usable.ok) {
        return {
            error:
                usable.reason === "scheduled"
                    ? (await getTranslations("drive"))("errors.notOpenYet")
                    : (await getTranslations("drive"))("errors.closed")
        };
    }

    const ip = await clientIp();
    const ipHash = hashForLog(ip);
    if (await linkAddressDenial(request, ip)) {
        return { error: (await getTranslations("drive"))("errors.networkDenied") };
    }
    if (!(await dymoIpAllowed(ip)).allowed) {
        return { error: (await getTranslations("drive"))("errors.networkDenied") };
    }

    const session = await getSession();
    const userId = session?.user?.id ?? null;
    if (request.requireLogin && !userId) return { error: (await getTranslations("drive"))("errors.signInToSend") };
    if (!(await textRequests.textRequestUserAllowed(request.allowedUsers, userId))) {
        return { error: (await getTranslations("drive"))("errors.accountDenied") };
    }
    if (request.passwordHash) {
        const cookieValue = (await cookies()).get(
            textRequests.textRequestUnlockCookie(request.id)
        )?.value;
        if (
            !textRequests.verifyTextRequestUnlock(
                request.id,
                cookieValue,
                request.passwordHash,
                loadEnv().POLARIS_AUTH_SECRET
            )
        ) {
            return { error: (await getTranslations("drive"))("errors.linkProtected") };
        }
    }

    if (
        !(await rateLimit(`textdrop-submit:${ipHash ?? "unknown"}`, SUBMIT_LIMIT, SUBMIT_WINDOW_MS))
            .ok
    ) {
        return { error: (await getTranslations("drive"))("errors.tooManySubmissions") };
    }

    const parsed = submitTextSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? (await getTranslations("drive"))("errors.invalidSubmission") };

    const result = await textRequests.submitText(request, parsed.data, {
        userId,
        ipHash: ipHash ?? null
    });
    if (!result.ok) {
        return {
            error:
                result.reason === "too_long"
                    ? (await getTranslations("drive"))("errors.textTooLong", { max: request.maxLength })
                    : result.reason === "full"
                      ? (await getTranslations("drive"))("errors.full")
                      : (await getTranslations("drive"))("errors.noSealed")
        };
    }

    await notify({
        userId: request.ownerId,
        event: "drive.dropPoint.received",
        // Written for the owner, who reads it later, in their own language.
        title: (await ownerWords(request.ownerId))("errors.arrived", { title: request.title }),
        body: parsed.data.name,
        href: `/drive/snippets/${result.snippetId}`
    });
    revalidateDropPoints(request.id);
    return { ok: true };
}

/** Drive's words in the owner's language; the default one when theirs cannot
 *  be read, so the notice is still sent. */
async function ownerWords(userId: string) {
    try {
        return translatorFor(await getUserLocale(userId), "drive");
    } catch {
        return translatorFor(DEFAULT_LOCALE, "drive");
    }
}
