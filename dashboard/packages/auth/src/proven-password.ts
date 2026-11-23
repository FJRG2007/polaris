/**
 * A password already proven over OPAQUE, accepted once by better-auth's
 * password check (docs/chat-e2ee-phase1.md, "Password flows over OPAQUE").
 *
 * Routes such as `/two-factor/enable` insist on a password in their body. A
 * server action that has just verified an OPAQUE proof for the account runs
 * the route inside `withProvenPassword`, which hands it a random stand-in
 * password; the wrapped `password.verify` (`passwordHasher` in auth.ts)
 * accepts that stand-in exactly once, for exactly that hash, within 30 s.
 *
 * Nothing is issued: the stand-in lives in this request's async context and
 * in the callback's argument, never in a response, a cookie or the database.
 * Another request - `/sign-in/email` among them - never runs inside the
 * scope, and even a call made inside it opens nothing unless it carries the
 * stand-in and the hash it was minted for.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, timingSafeEqual } from "node:crypto";

/** How long the stand-in is good for after the proof. */
export const PROVEN_PASSWORD_LIFETIME_MS = 30_000;

interface ProvenScope {
    readonly hash: string;
    readonly standIn: string;
    readonly mintedAt: number;
    used: boolean;
}

const scopes = new AsyncLocalStorage<ProvenScope>();

function same(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Run `run` with a stand-in for the password whose hash is `hash`. Only for a
 * caller that has just verified an OPAQUE proof for that account, and read
 * `hash` as the account's current one.
 */
export function withProvenPassword<T>(hash: string, run: (standIn: string) => Promise<T>): Promise<T> {
    if (!hash) throw new RangeError("A proven password belongs to a hash");
    const scope: ProvenScope = {
        hash,
        standIn: randomBytes(32).toString("base64url"),
        mintedAt: Date.now(),
        used: false
    };
    return scopes.run(scope, () => run(scope.standIn));
}

/** True, once, when this check is the one the current scope was made for. */
export function spendProvenPassword(input: { hash: string; password: string }): boolean {
    const scope = scopes.getStore();
    if (!scope || scope.used) return false;
    if (Date.now() - scope.mintedAt >= PROVEN_PASSWORD_LIFETIME_MS) return false;
    if (!same(scope.standIn, input.password) || !same(scope.hash, input.hash)) return false;
    scope.used = true;
    return true;
}
