/**
 * The two end-to-end encryption routes, as plain functions over a Request so
 * the tests drive exactly what the route files serve.
 *
 * `/api/e2ee/sign-in` runs before there is a session: the OPAQUE sign-in, and
 * the adoption that moves an account onto OPAQUE right after a password sign-in
 * succeeded. `/api/e2ee/keys` needs a session and only ever touches the
 * signed-in account's own rows.
 *
 * Both answer 404 while the internal flag is off - nothing about them exists
 * until the stack is switched on. Refusals are one fixed body whatever the
 * cause; internals are logged, never returned.
 */

import { auth } from "@/lib/auth";
import * as keys from "./account-keys";
import { chatE2eeEnabled } from "./flag";
import { NextResponse } from "next/server";
import * as opaque from "./opaque-service";
import { backgroundUser } from "@/lib/session";
import { clientIp } from "@/lib/request-context";
import { signInWithOpaque } from "@polaris/auth";
import { keysBody, signInBody } from "./schemas";
import { rateLimit } from "@/lib/rate-limit-service";

const WINDOW_MS = 15 * 60 * 1000;
const PER_ACCOUNT = 10;
const PER_ADDRESS = 60;

let decoyHash: Promise<string> | null = null;

const NOT_FOUND = { error: "Not found" } as const;
const REFUSED = { error: "refused" } as const;

function json(body: unknown, status = 200): NextResponse {
    return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * The body, only when sent as JSON. A cross-site form or `text/plain` fetch can
 * post without a preflight; `application/json` cannot, so insisting on it is
 * what keeps another site from driving these routes with the visitor's cookies
 * (or signing the visitor into an account the attacker proved).
 */
async function readBody(request: Request): Promise<unknown> {
    const type = request.headers.get("content-type") ?? "";
    if (!/^application\/json(;|$)/i.test(type.trim())) return null;
    try {
        return await request.json();
    } catch {
        return null;
    }
}

function bytes(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, "base64url"));
}

function text(value: Uint8Array): string {
    return Buffer.from(value).toString("base64url");
}

/** Both limits must allow it; the first that refuses answers. */
async function limited(keysToCount: readonly [string, number][]): Promise<NextResponse | null> {
    const results = await Promise.all(keysToCount.map(([key, limit]) => rateLimit(key, limit, WINDOW_MS)));
    const refused = results.find((result) => !result.ok);
    return refused ? json({ error: "tooMany", retryAfterMs: refused.retryAfterMs }, 429) : null;
}

async function addressKey(): Promise<string> {
    return (await clientIp()) ?? "unknown";
}

/** Store the password envelope sent with a successful finish, for that account. */
async function storePasswordLock(
    userId: string,
    lock: { akVersion: number; envelope: string } | undefined
): Promise<void> {
    if (!lock) return;
    await keys.putLock(userId, {
        kind: "password",
        lockId: keys.PASSWORD_LOCK_ID,
        akVersion: lock.akVersion,
        envelope: bytes(lock.envelope)
    });
}

async function releasedEnvelope(userId: string): Promise<{ akVersion: number; envelope: string } | null> {
    const found = await keys.passwordEnvelope(userId);
    return found ? { akVersion: found.akVersion, envelope: text(found.envelope) } : null;
}

export async function handleSignIn(request: Request): Promise<Response> {
    if (!chatE2eeEnabled()) return json(NOT_FOUND, 404);
    const parsed = signInBody.safeParse(await readBody(request));
    if (!parsed.success) return json({ error: "invalid" }, 400);
    const body = parsed.data;
    const address = await addressKey();
    try {
        switch (body.op) {
            case "sign-in-start":
            case "verify-start": {
                const refusal = await limited([
                    [`e2ee-sign-in-address:${address}`, PER_ADDRESS],
                    [`e2ee-sign-in:${body.email}`, PER_ACCOUNT]
                ]);
                if (refusal) return refusal;
                void opaque.sweepLogins().catch(() => undefined);
                const identity = await opaque.identityFor(body.email);
                const started = await opaque.startLogin(
                    identity,
                    body.op === "sign-in-start" ? "sign-in" : "verify",
                    body.startLoginRequest
                );
                return json({ ...started, userId: identity.userId });
            }
            case "sign-in-finish": {
                const proved = await opaque.finishLogin(body.loginId, "sign-in", body.finishLoginRequest);
                const issued = await signInWithOpaque(auth, proved.userId, request.headers);
                // The envelope only with a full session: an account with a second
                // factor armed gets it from the unlock after answering the
                // challenge, so the password alone never yields it.
                const response = json({
                    challenged: issued.challenged,
                    passwordLock: issued.challenged ? null : await releasedEnvelope(proved.userId)
                });
                for (const cookie of issued.cookies)
                    response.cookies.set(cookie.name, cookie.value, cookie.options);
                return response;
            }
            case "adopt-start": {
                const refusal = await limited([
                    [`e2ee-sign-in-address:${address}`, PER_ADDRESS],
                    [`e2ee-adopt:${body.email}`, PER_ACCOUNT]
                ]);
                if (refusal) return refusal;
                const identity = await opaque.identityFor(body.email);
                return json({
                    userId: identity.userId,
                    registrationResponse: await opaque.registrationResponse(
                        identity.userId,
                        body.registrationRequest
                    )
                });
            }
            case "adopt-finish": {
                const refusal = await limited([
                    [`e2ee-sign-in-address:${address}`, PER_ADDRESS],
                    [`e2ee-adopt:${body.email}`, PER_ACCOUNT]
                ]);
                if (refusal) return refusal;
                const identity = await opaque.identityFor(body.email);
                const hash = identity.known ? await opaque.credentialHash(identity.userId) : null;
                const context = await auth.$context;
                // An address with no password still pays for one verification,
                // so the time taken does not say which addresses have one.
                decoyHash ??= context.password.hash("polaris-decoy-password");
                const matches = await context.password.verify({
                    hash: hash ?? (await decoyHash),
                    password: body.password
                });
                if (!hash || !matches) return json(REFUSED, 401);
                await opaque.storePendingRecord(identity.userId, hash, body.registrationRecord);
                return json({ stored: true });
            }
            case "verify-finish": {
                const proved = await opaque.finishLogin(body.loginId, "verify", body.finishLoginRequest);
                const verified = await opaque.markVerified(proved.userId, proved.recordDigest);
                // No envelope either way: this runs before any second factor was
                // answered, and the password lock is sealed from the unlock.
                return json({ verified });
            }
        }
    } catch (caught) {
        if (caught instanceof opaque.OpaqueRefusal) return json(REFUSED, 401);
        console.error("polaris: an end-to-end encryption sign-in step failed:", caught);
        return json(REFUSED, 401);
    }
}

export async function handleKeys(request: Request): Promise<Response> {
    if (!chatE2eeEnabled()) return json(NOT_FOUND, 404);
    const user = await backgroundUser();
    // i18n-ignore: a status body no screen shows
    if (!user) return json({ error: "Unauthorized" }, 401);
    const parsed = keysBody.safeParse(await readBody(request));
    if (!parsed.success) return json({ error: "invalid" }, 400);
    const body = parsed.data;
    try {
        switch (body.op) {
            case "state": {
                const state = await keys.accountKeyState(user.id);
                return json({
                    userId: user.id,
                    accountKey: state && {
                        akVersion: state.akVersion,
                        signPublicKey: text(state.signPublicKey),
                        hpkePublicKey: text(state.hpkePublicKey),
                        hasPasswordLock: state.hasPasswordLock,
                        passkeyLocks: state.passkeyLocks.map((lock) => ({
                            lockId: lock.lockId,
                            akVersion: lock.akVersion,
                            envelope: text(lock.envelope)
                        }))
                    },
                    adopted: await opaque.adopted(user.id)
                });
            }
            case "create-account-key": {
                const created = await keys.createAccountKey(user.id, {
                    akVersion: body.akVersion,
                    signPublicKey: bytes(body.signPublicKey),
                    hpkePublicKey: bytes(body.hpkePublicKey)
                });
                return created ? json({ created }) : json({ error: "exists" }, 409);
            }
            case "put-passkey-lock": {
                const stored = await keys.putLock(user.id, {
                    kind: "passkey-prf",
                    lockId: body.lockId,
                    akVersion: body.akVersion,
                    envelope: bytes(body.envelope)
                });
                return stored ? json({ stored }) : json({ error: "stale" }, 409);
            }
            case "delete-passkey-lock": {
                await keys.deletePasskeyLock(user.id, body.lockId);
                return json({ deleted: true });
            }
            case "unlock-start": {
                const refusal = await limited([[`e2ee-unlock:${user.id}`, PER_ACCOUNT]]);
                if (refusal) return refusal;
                const started = await opaque.startLogin(
                    { userId: user.id, known: true },
                    "unlock",
                    body.startLoginRequest
                );
                return json({ ...started, userId: user.id });
            }
            case "unlock-finish": {
                const proved = await opaque.finishLogin(
                    body.loginId,
                    "unlock",
                    body.finishLoginRequest,
                    user.id
                );
                await storePasswordLock(proved.userId, body.passwordLock);
                return json({ passwordLock: await releasedEnvelope(proved.userId) });
            }
        }
    } catch (caught) {
        if (caught instanceof opaque.OpaqueRefusal) return json(REFUSED, 401);
        console.error("polaris: an end-to-end encryption key step failed:", caught);
        return json(REFUSED, 401);
    }
}
