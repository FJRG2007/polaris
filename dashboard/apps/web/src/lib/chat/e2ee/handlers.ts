/**
 * The two end-to-end encryption routes, as plain functions over a Request so
 * the tests drive exactly what the route files serve.
 *
 * `/api/e2ee/sign-in` runs before there is a session: the OPAQUE sign-in, and
 * the adoption that moves an account onto OPAQUE right after a password sign-in
 * succeeded. `/api/e2ee/keys` needs a session and only ever touches the
 * signed-in account's own rows.
 *
 * Both answer 404 while their switch is off (`passwordLockEnabled()` for the
 * password lock, `chatE2eeEnabled()` for the passkey locks) - nothing about
 * them exists then - with one exception that keeps the kill switch from ever
 * locking anybody out: an account already on OPAQUE (a verified record for its
 * current password) keeps signing in, proving and setting its password over
 * OPAQUE whatever the switch says. Its password may exist nowhere else - one set
 * over OPAQUE leaves no usable hash. The switch only stops moving accounts that
 * are not on it yet. Refusals are one fixed body whatever the cause; internals
 * are logged, never returned.
 */

import { auth } from "@/lib/auth";
import * as keys from "./account-keys";
import { chatE2eeEnabled, passwordLockEnabled } from "./flag";
import { NextResponse } from "next/server";
import * as opaque from "./opaque-service";
import { backgroundUser } from "@/lib/session";
import { clientIp } from "@/lib/request-context";
import { signInWithOpaque } from "@polaris/auth";
import { keysBody, signInBody } from "./schemas";
import type { KeysBody } from "./schemas";
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
    const parsed = signInBody.safeParse(await readBody(request));
    // With the kill switch the sign-in itself stays, for the accounts already on
    // OPAQUE: a start for any other address runs against no record (as it does
    // for an unknown one) and can never finish. Moving an account (adopt,
    // verify) is what the switch stops.
    const signingIn = parsed.success && (parsed.data.op === "sign-in-start" || parsed.data.op === "sign-in-finish");
    if (!passwordLockEnabled() && !signingIn) return json(NOT_FOUND, 404);
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
                await opaque.storePendingRecord(identity.userId, hash, body.registrationRecord, body.ksfVersion);
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

/**
 * Which switch an account-key operation sits behind: the passkey PRF locks stay
 * with chat encryption's internal flag, everything the password lock needs
 * (reading the state, creating the key, the OPAQUE unlock) with the password
 * lock's own.
 */
function opEnabled(op: KeysBody["op"], onOpaque: boolean): boolean {
    if (op === "put-passkey-lock" || op === "delete-passkey-lock") return chatE2eeEnabled();
    return passwordLockEnabled() || chatE2eeEnabled() || onOpaque;
}

export async function handleKeys(request: Request): Promise<Response> {
    const switchedOn = passwordLockEnabled() || chatE2eeEnabled();
    const user = await backgroundUser();
    // With every switch off, the route exists only for an account already on
    // OPAQUE (its password may live nowhere else); the rest get the 404 as before.
    const onOpaque = !switchedOn && user ? await opaque.adopted(user.id) : false;
    if (!switchedOn && !onOpaque) return json(NOT_FOUND, 404);
    // i18n-ignore: a status body no screen shows
    if (!user) return json({ error: "Unauthorized" }, 401);
    const parsed = keysBody.safeParse(await readBody(request));
    if (!parsed.success) return json({ error: "invalid" }, 400);
    const body = parsed.data;
    if (!opEnabled(body.op, onOpaque)) return json(NOT_FOUND, 404);
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
                    adopted: await opaque.adopted(user.id),
                    // What a new password must not be built from, for the rules
                    // the browser checks before registering one.
                    identity: { name: user.name, email: user.email }
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
            case "proof-start": {
                const refusal = await limited([[`e2ee-proof:${user.id}`, PER_ACCOUNT]]);
                if (refusal) return refusal;
                const started = await opaque.startLogin(
                    { userId: user.id, known: true },
                    "proof",
                    body.startLoginRequest,
                    user.sessionId
                );
                return json({ ...started, userId: user.id });
            }
            case "set-start": {
                const refusal = await limited([[`e2ee-set:${user.id}`, PER_ACCOUNT]]);
                if (refusal) return refusal;
                return json({
                    userId: user.id,
                    registrationResponse: await opaque.registrationResponse(user.id, body.registrationRequest)
                });
            }
            case "set-verify": {
                const refusal = await limited([[`e2ee-set:${user.id}`, PER_ACCOUNT]]);
                if (refusal) return refusal;
                const started = await opaque.startSetLogin(
                    user.id,
                    body.registrationRecord,
                    body.ksfVersion,
                    body.startLoginRequest,
                    user.sessionId
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
