/**
 * Text drop points: a URL that asks somebody for text.
 *
 * The mirror image of a snippet link, and the text counterpart of a file drop
 * point - an .env, a private key, a log somebody needs to hand over without
 * putting it in a chat. What arrives becomes a snippet owned by whoever opened
 * the drop point, so it is read, searched and deleted in the same place as
 * everything else they hold.
 *
 * Because the submit endpoint can be anonymous, every limit here is a security
 * control enforced server-side on each submission: the page never gets to decide
 * whether it is within its own rules.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { sharingBaseUrl } from "@/lib/domain-service";
import { generateToken, hashToken } from "@polaris/core/tokens";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { randomDropPointName, userAllowedForRequest } from "@polaris/core";
import { hashLinkPassword, verifyLinkPassword } from "@polaris/core/link-password";
import type { CreateTextRequestInput, SubmitTextInput, UpdateTextRequestInput } from "@polaris/core";
import {
    linkUsability,
    parseStringList,
    signUnlock,
    unlockCookieName,
    verifyUnlock,
    type LinkUsability
} from "@/lib/link-guards";

/** The unlock-cookie namespace text drop points are signed under. */
const TEXT_DROP_SCOPE = "textdrop";

/** A drop point as the public page needs it. */
export type TextRequestRecord = Awaited<ReturnType<typeof resolveTextRequestByToken>>;

/** Why a drop point is not accepting text right now, or `ok`. */
export type TextRequestUsability = LinkUsability;

/** Create a drop point and return the one-time raw token for its link. */
export async function createTextRequest(
    ownerId: string,
    input: CreateTextRequestInput
): Promise<{ id: string; token: string }> {
    const token = generateToken();
    const blob = encryptSecret(token, loadEnv().POLARIS_MASTER_KEY);
    const request = await prisma.textRequest.create({
        data: {
            ownerId,
            tokenHash: hashToken(token),
            encryptedToken: blob.ciphertext,
            tokenNonce: blob.nonce,
            tokenKeyId: blob.keyId,
            title: input.title?.trim() || randomDropPointName(),
            instructions: input.instructions ?? null,
            passwordHash: input.password ? await hashLinkPassword(input.password) : null,
            // A per-user allowlist is meaningless without an identity to match, so
            // naming anybody turns signing in on whatever the checkbox said.
            requireLogin: input.requireLogin || input.allowedUsers.length > 0,
            allowedUsers: JSON.stringify(input.allowedUsers),
            maxLength: input.maxLength,
            maxSubmissions: input.maxSubmissions ?? null,
            allowSealed: input.allowSealed,
            allowedCidrs: JSON.stringify(input.allowedCidrs),
            allowedCountries: JSON.stringify(input.allowedCountries),
            allowedContinents: JSON.stringify(input.allowedContinents),
            startsAt: input.startsAt ?? null,
            expiresAt: input.expiresAt ?? null
        },
        select: { id: true }
    });
    return { id: request.id, token };
}

/** Every text drop point a user owns, newest first, with what has arrived. */
export async function listTextRequestsForOwner(ownerId: string) {
    return prisma.textRequest.findMany({
        where: { ownerId },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            title: true,
            instructions: true,
            requireLogin: true,
            allowSealed: true,
            maxLength: true,
            maxSubmissions: true,
            startsAt: true,
            expiresAt: true,
            revokedAt: true,
            createdAt: true,
            encryptedToken: true,
            _count: { select: { submissions: true } }
        }
    });
}

/** One drop point, for its owner's settings screen. Null when not theirs. */
export async function getTextRequestForOwner(ownerId: string, requestId: string) {
    return prisma.textRequest.findFirst({
        where: { id: requestId, ownerId },
        select: {
            id: true,
            title: true,
            instructions: true,
            requireLogin: true,
            allowSealed: true,
            allowedUsers: true,
            maxLength: true,
            maxSubmissions: true,
            allowedCidrs: true,
            allowedCountries: true,
            allowedContinents: true,
            startsAt: true,
            expiresAt: true,
            revokedAt: true,
            createdAt: true,
            passwordHash: true,
            _count: { select: { submissions: true } }
        }
    });
}

/** Update a drop point's guardrails. Owner-scoped; only sent fields change. */
export async function updateTextRequest(
    ownerId: string,
    requestId: string,
    input: UpdateTextRequestInput
): Promise<void> {
    const data: Record<string, unknown> = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.instructions !== undefined) data.instructions = input.instructions;
    if (input.password !== undefined) {
        data.passwordHash = input.password ? await hashLinkPassword(input.password) : null;
    }
    if (input.maxLength !== undefined) data.maxLength = input.maxLength;
    if (input.maxSubmissions !== undefined) data.maxSubmissions = input.maxSubmissions;
    if (input.allowSealed !== undefined) data.allowSealed = input.allowSealed;
    if (input.allowedUsers !== undefined) {
        const users = Array.from(
            new Set(input.allowedUsers.map((value) => value.replace(/^@+/, "")).filter(Boolean))
        );
        data.allowedUsers = JSON.stringify(users);
        // Same rule as at creation: naming people implies they must identify
        // themselves, whatever the sign-in switch was set to.
        if (users.length > 0) data.requireLogin = true;
    }
    if (input.requireLogin !== undefined && data.requireLogin === undefined) {
        data.requireLogin = input.requireLogin;
    }
    if (input.allowedCidrs !== undefined) data.allowedCidrs = JSON.stringify(input.allowedCidrs);
    if (input.allowedCountries !== undefined) {
        data.allowedCountries = JSON.stringify(input.allowedCountries);
    }
    if (input.allowedContinents !== undefined) {
        data.allowedContinents = JSON.stringify(input.allowedContinents);
    }
    if (input.startsAt !== undefined) data.startsAt = input.startsAt;
    if (input.expiresAt !== undefined) data.expiresAt = input.expiresAt;
    await prisma.textRequest.updateMany({ where: { id: requestId, ownerId }, data });
}

/** Close a drop point. Idempotent, and scoped so IDOR is impossible. */
export async function revokeTextRequest(ownerId: string, requestId: string): Promise<void> {
    await prisma.textRequest.updateMany({
        where: { id: requestId, ownerId, revokedAt: null },
        data: { revokedAt: new Date() }
    });
}

/**
 * Re-open a closed drop point. A window that has already passed is cleared as
 * well: re-opening something into an expiry in the past would look like it
 * worked and accept nothing.
 */
export async function reopenTextRequest(ownerId: string, requestId: string): Promise<void> {
    const request = await prisma.textRequest.findFirst({
        where: { id: requestId, ownerId },
        select: { expiresAt: true }
    });
    if (!request) return;
    const expired = request.expiresAt !== null && request.expiresAt.getTime() <= Date.now();
    await prisma.textRequest.updateMany({
        where: { id: requestId, ownerId },
        data: { revokedAt: null, ...(expired ? { expiresAt: null } : {}) }
    });
}

/**
 * Delete a drop point. What it collected stays: those are the owner's snippets
 * now, and closing the door is not a reason to burn what came through it.
 */
export async function deleteTextRequest(ownerId: string, requestId: string): Promise<boolean> {
    const { count } = await prisma.textRequest.deleteMany({ where: { id: requestId, ownerId } });
    return count === 1;
}

/** Decrypt and return the link for a drop point the caller owns, or null. */
export async function revealTextRequestLink(
    ownerId: string,
    requestId: string
): Promise<string | null> {
    const request = await prisma.textRequest.findFirst({
        where: { id: requestId, ownerId },
        select: { encryptedToken: true, tokenNonce: true, tokenKeyId: true }
    });
    if (!request?.encryptedToken || !request.tokenNonce) return null;
    const token = decryptSecret(
        {
            ciphertext: Buffer.from(request.encryptedToken),
            nonce: Buffer.from(request.tokenNonce),
            keyId: request.tokenKeyId ?? ""
        },
        loadEnv().POLARIS_MASTER_KEY
    );
    return `${await sharingBaseUrl()}/tr/${token}`;
}

/** Resolve a drop point by its raw token (looked up by hash), or null. */
export async function resolveTextRequestByToken(token: string) {
    return prisma.textRequest.findUnique({
        where: { tokenHash: hashToken(token) },
        select: {
            id: true,
            ownerId: true,
            title: true,
            instructions: true,
            requireLogin: true,
            allowSealed: true,
            allowedUsers: true,
            maxLength: true,
            maxSubmissions: true,
            passwordHash: true,
            allowedCidrs: true,
            allowedCountries: true,
            allowedContinents: true,
            startsAt: true,
            expiresAt: true,
            revokedAt: true
        }
    });
}

/** Whether a drop point is currently accepting text. */
export function textRequestUsability(request: {
    revokedAt: Date | null;
    expiresAt: Date | null;
    startsAt?: Date | null;
    now?: Date;
}): TextRequestUsability {
    return linkUsability(
        {
            revokedAt: request.revokedAt,
            expiresAt: request.expiresAt,
            startsAt: request.startsAt ?? null,
            // The submission cap is counted against the snippets it produced, not
            // held on this row, so it is checked separately in submitText.
            maxUses: null,
            useCount: 0
        },
        request.now ?? new Date()
    );
}

/** How many submissions a drop point has taken, for its cap. */
export async function countTextSubmissions(requestId: string): Promise<number> {
    return prisma.snippet.count({ where: { requestId } });
}

/**
 * Whether a signed-in sender passes a drop point's per-user allowlist. An empty
 * list is open to anyone; otherwise the caller must be signed in and named.
 */
export async function textRequestUserAllowed(
    allowedUsersJson: string,
    userId: string | null
): Promise<boolean> {
    const allowed = parseStringList(allowedUsersJson);
    if (allowed.length === 0) return true;
    if (!userId) return false;
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, username: true }
    });
    if (!user) return false;
    return userAllowedForRequest(user, allowed);
}

/** Why a submission was refused, or the snippet it became. */
export type TextSubmissionResult =
    | { ok: true; snippetId: string }
    | { ok: false; reason: "too_long" | "full" | "sealed_not_allowed" };

/**
 * Store one submission as a snippet owned by the drop point's owner.
 *
 * The cap is checked here rather than in the caller so no route can forget it.
 * Two submissions arriving in the same instant can both pass a count taken
 * before either row exists - the same race the file drop point has - which
 * overshoots a cap by one rather than losing anything, and is the trade every
 * cheap counter makes.
 */
export async function submitText(
    request: {
        id: string;
        ownerId: string;
        maxLength: number;
        maxSubmissions: number | null;
        allowSealed: boolean;
    },
    input: SubmitTextInput,
    context: { userId: string | null; ipHash: string | null }
): Promise<TextSubmissionResult> {
    if (input.body.length > request.maxLength) return { ok: false, reason: "too_long" };
    if (input.sealed && !request.allowSealed) return { ok: false, reason: "sealed_not_allowed" };
    if (request.maxSubmissions !== null) {
        const taken = await countTextSubmissions(request.id);
        if (taken >= request.maxSubmissions) return { ok: false, reason: "full" };
    }

    const blob = encryptSecret(input.body, loadEnv().POLARIS_MASTER_KEY);
    const snippet = await prisma.snippet.create({
        data: {
            ownerId: request.ownerId,
            requestId: request.id,
            submittedByUserId: context.userId,
            submittedIpHash: context.ipHash,
            title: input.title?.trim() || input.name,
            visibility: "private",
            clientSealed: input.sealed,
            files: {
                create: {
                    name: input.name,
                    // A sealed body is ciphertext; calling it a language would be
                    // a claim about bytes nobody here can read.
                    language: "",
                    position: 0,
                    encryptedBody: blob.ciphertext,
                    bodyNonce: blob.nonce,
                    bodyKeyId: blob.keyId,
                    size: Buffer.byteLength(input.body, "utf8")
                }
            }
        },
        select: { id: true }
    });
    return { ok: true, snippetId: snippet.id };
}

/** Constant-time password check. No password set means the page is open. */
export async function verifyTextRequestPassword(
    passwordHash: string | null,
    presented: string
): Promise<boolean> {
    if (!passwordHash) return true;
    return verifyLinkPassword(presented, passwordHash);
}

/** Cookie name recording a solved password for one drop point. */
export function textRequestUnlockCookie(requestId: string): string {
    return unlockCookieName(TEXT_DROP_SCOPE, requestId);
}

/** Sign an unlock marker so the "password solved" cookie cannot be forged. */
export function signTextRequestUnlock(requestId: string, secret: string): string {
    return signUnlock(TEXT_DROP_SCOPE, requestId, secret);
}

/** Constant-time check of an unlock cookie against its expected signature. */
export function verifyTextRequestUnlock(
    requestId: string,
    value: string | undefined,
    secret: string
): boolean {
    return verifyUnlock(TEXT_DROP_SCOPE, requestId, value, secret);
}
