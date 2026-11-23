"use server";

/**
 * Signing in with no password: the account's phone approves this browser.
 *
 * Modelled on Microsoft Authenticator's passwordless phone sign-in (number
 * matching on every request, the phone's own screen lock in front of the
 * answer) and on Google's sign-in prompts (offered for the account typed, on a
 * phone already signed in to it).
 *
 * - The browser that asks gets a random secret in an http-only cookie, and the
 *   request is stored under its hash. Only that browser can collect the answer,
 *   so an approval cannot be spent by whoever else knows the request id.
 * - The number is mandatory: the phone lists it among three, a wrong pick denies
 *   and counts, and three wrong picks in an hour rest phone approval for the
 *   account (`phoneCanApprove`). An old phone app with no number cannot approve.
 * - Rate limited per address, per account, and per browser poll.
 * - The session is issued by better-auth through the sealed phone sign-in
 *   endpoint, so the enforced identity provider, the sign-in listeners, the
 *   sign-in record, the new-device grace and the lockdown all apply exactly as
 *   they do after a password.
 */

import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { describeDevice } from "@polaris/core";
import { resolveGeo } from "@/lib/geo-service";
import { cookies, headers } from "next/headers";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { createHash, randomBytes } from "node:crypto";
import { resolveIdentifier } from "@/app/oauth/login/actions";
import { clientIp, clientUserAgent } from "@/lib/request-context";
import { signInWithPhone, SSO_REQUIRED_CODE } from "@polaris/auth";
import { APPROVAL_TTL_MS, collectSignIn, phoneCanApprove, requestApproval } from "@/lib/mobile/sign-in-approval";

const COOKIE = "polaris.phone-sign-in";
const identifierSchema = z.string().trim().min(1).max(320);
const approvalIdSchema = z.string().uuid();
/** The prompt goes out without a place rather than wait on a slow lookup. */
const PLACE_WAIT_MS = 1_500;
const WINDOW_MS = 10 * 60_000;

export type PhoneSignInStart =
    | { ok: true; id: string; matchNumber: number }
    | { ok: false; reason: "unavailable" | "tooMany" };

export type PhoneSignInState =
    | { state: "pending" | "expired" }
    | { state: "denied"; reason: "not-me" | "mismatch" }
    | { state: "approved" }
    | { state: "refused"; reason: "sso" | "failed" };

function keyOf(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** The account behind what was typed, when it is one a phone could sign in. */
async function accountFor(identifier: string): Promise<string | null> {
    const email = await resolveIdentifier(identifier);
    if (!email) return null;
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, bannedAt: true } });
    if (!user || user.bannedAt) return null;
    return (await phoneCanApprove(user.id)) ? user.id : null;
}

/**
 * Whether to offer "Sign in with your phone" for what was typed. An oracle like
 * the passkey hint beside it, and throttled the same way: an account with no
 * phone and an address with no account answer alike.
 */
export async function phoneSignInOffered(identifier: unknown): Promise<boolean> {
    const parsed = identifierSchema.safeParse(identifier);
    if (!parsed.success) return false;
    const value = parsed.data.toLowerCase();
    const throttle = await rateLimit(`phone-sign-in-hint:${value}`, 10, WINDOW_MS);
    if (!throttle.ok) return false;
    return (await accountFor(value)) !== null;
}

/** "Madrid, Spain", or whatever part of it is known, or null. */
async function approximatePlace(ip: string | undefined): Promise<string | null> {
    if (!ip) return null;
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), PLACE_WAIT_MS));
    const geo = await Promise.race([resolveGeo(ip).catch(() => null), timeout]);
    if (!geo) return null;
    return [geo.city, geo.country].filter(Boolean).join(", ") || null;
}

export async function startPhoneSignInAction(identifier: unknown): Promise<PhoneSignInStart> {
    const parsed = identifierSchema.safeParse(identifier);
    if (!parsed.success) return { ok: false, reason: "unavailable" };
    const value = parsed.data.toLowerCase();
    const [userAgent, ip] = await Promise.all([clientUserAgent(), clientIp()]);
    const [perAddress, perIdentifier] = await Promise.all([
        rateLimit(`phone-sign-in:address:${ip ?? "unknown"}`, 10, WINDOW_MS),
        rateLimit(`phone-sign-in:identifier:${keyOf(value)}`, 5, WINDOW_MS)
    ]);
    if (!perAddress.ok || !perIdentifier.ok) return { ok: false, reason: "tooMany" };
    const userId = await accountFor(value);
    if (!userId) return { ok: false, reason: "unavailable" };
    // Shared with the second-factor prompt: each one buzzes the same phone.
    const perAccount = await rateLimit(`phone-approval:user:${userId}`, 10, WINDOW_MS);
    if (!perAccount.ok) return { ok: false, reason: "tooMany" };

    const secret = randomBytes(32).toString("base64url");
    const { id, matchNumber } = await requestApproval({
        userId,
        identifier: secret,
        purpose: "sign-in",
        device: userAgent ? describeDevice(userAgent) : null,
        ip: ip ?? null,
        place: await approximatePlace(ip)
    });
    (await cookies()).set(COOKIE, secret, {
        httpOnly: true,
        sameSite: "strict",
        secure: loadEnv().POLARIS_SECURE_COOKIES,
        path: "/",
        maxAge: Math.ceil(APPROVAL_TTL_MS / 1000) + 30
    });
    await recordAudit({
        actorId: userId,
        action: "account.phone-sign-in.requested",
        targetType: "sign-in-approval",
        targetId: id
    });
    return { ok: true, id, matchNumber };
}

function refusalOf(caught: unknown): "sso" | "failed" {
    const code = (caught as { body?: { code?: unknown } } | null)?.body?.code;
    return code === SSO_REQUIRED_CODE ? "sso" : "failed";
}

export async function phoneSignInStatusAction(id: unknown): Promise<PhoneSignInState> {
    const parsed = approvalIdSchema.safeParse(id);
    const store = await cookies();
    const secret = store.get(COOKIE)?.value;
    if (!parsed.success || !secret) return { state: "expired" };
    const allowed = await rateLimit(`phone-sign-in:poll:${keyOf(secret)}`, 90, 60_000);
    if (!allowed.ok) return { state: "pending" };
    const settled = await collectSignIn(secret, parsed.data);
    if (settled.state !== "approved") return settled;

    store.delete(COOKIE);
    try {
        const issued = await signInWithPhone(auth, settled.userId, await headers());
        for (const cookie of issued.cookies) store.set(cookie.name, cookie.value, cookie.options);
    } catch (caught) {
        const reason = refusalOf(caught);
        if (reason === "failed") console.error("polaris: a phone sign-in could not issue its session:", caught);
        return { state: "refused", reason };
    }
    await recordAudit({
        actorId: settled.userId,
        action: "account.phone-sign-in.approved",
        targetType: "sign-in-approval",
        targetId: parsed.data
    });
    return { state: "approved" };
}

/** The person gave up waiting: forget the browser's secret. The phone's prompt expires on its own. */
export async function cancelPhoneSignInAction(): Promise<void> {
    (await cookies()).delete(COOKIE);
}
