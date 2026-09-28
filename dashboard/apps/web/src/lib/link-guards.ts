/**
 * The guards every public link in Polaris is subject to.
 *
 * A share, a drop point, a snippet and a one-time secret are four different
 * things that hand a stranger a URL, and every one of them answers the same
 * questions before it serves anything: is the link still live, is the caller
 * coming from somewhere it accepts, and has the password been solved. That logic
 * was written twice before this module existed - once for shares, once for file
 * requests - and the second copy is where a gap opens up, because a fix applied
 * to one is not applied to the other.
 *
 * So the rules live here once, against a shape rather than a table: any row with
 * the standard columns can be gated, whatever it is. The per-surface services
 * keep their own names for their own limits (a share counts downloads, a snippet
 * counts views) and map them onto this.
 *
 * Server-only: it reads cookies and the request context.
 */

import { ipAllowed } from "@polaris/core";
import { geoAllowedForIp } from "@/lib/geo-service";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** The limits every link carries, whatever it points at. */
export interface LinkLimits {
    revokedAt: Date | null;
    expiresAt: Date | null;
    /** When set, the link is not live yet. Only drop points schedule this. */
    startsAt?: Date | null;
    /** The cap on uses, or null for no cap. */
    maxUses: number | null;
    useCount: number;
}

/** Why a link cannot be used right now, or `ok`. */
export type LinkUsability =
    | { ok: true }
    | { ok: false; reason: "revoked" | "expired" | "exhausted" | "scheduled" };

/** Where a link's rules refused the caller, in the order they are checked. */
export type LinkDenial = "not_allowed" | "ip_not_allowed" | "country_not_allowed";

/**
 * Whether a link is currently serveable. Revocation wins over everything: a link
 * somebody turned off is off even if it would otherwise still be within its
 * window.
 */
export function linkUsability(limits: LinkLimits, now: Date = new Date()): LinkUsability {
    if (limits.revokedAt) return { ok: false, reason: "revoked" };
    if (limits.startsAt && limits.startsAt.getTime() > now.getTime()) {
        return { ok: false, reason: "scheduled" };
    }
    if (limits.expiresAt && limits.expiresAt.getTime() <= now.getTime()) {
        return { ok: false, reason: "expired" };
    }
    if (limits.maxUses !== null && limits.useCount >= limits.maxUses) {
        return { ok: false, reason: "exhausted" };
    }
    return { ok: true };
}

/**
 * Parse a stored JSON string array. Anything unparseable reads as empty, which
 * every caller treats as "no restriction" - a corrupt column must not be able to
 * lock the owner out of their own link, and it cannot open one either, because
 * the token and the password are separate gates.
 */
export function parseStringList(json: string): string[] {
    try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed)
            ? parsed.filter((value): value is string => typeof value === "string")
            : [];
    } catch {
        return [];
    }
}

/** Whether a client IP passes an IP/CIDR allowlist. Empty means anyone. */
export function linkIpAllowed(allowedCidrsJson: string, ip: string | undefined): boolean {
    const rules = parseStringList(allowedCidrsJson);
    if (rules.length === 0) return true;
    if (!ip) return false;
    return ipAllowed(ip, rules);
}

/** Whether a client IP passes a country/continent allowlist (may resolve geo). */
export async function linkGeoAllowed(
    allowedCountriesJson: string,
    allowedContinentsJson: string,
    ip: string | undefined
): Promise<boolean> {
    return geoAllowedForIp(
        ip,
        parseStringList(allowedCountriesJson),
        parseStringList(allowedContinentsJson)
    );
}

/** Both address rules in the order the public endpoints apply them, or null. */
export async function linkAddressDenial(
    rules: { allowedCidrs: string; allowedCountries: string; allowedContinents: string },
    ip: string | undefined
): Promise<LinkDenial | null> {
    if (!linkIpAllowed(rules.allowedCidrs, ip)) return "ip_not_allowed";
    if (!(await linkGeoAllowed(rules.allowedCountries, rules.allowedContinents, ip))) {
        return "country_not_allowed";
    }
    return null;
}

/** The cookie that records a solved password for one link. */
export function unlockCookieName(scope: string, id: string): string {
    return `polaris_${scope}_${id}`;
}

/** How long a solved password is honoured - by the server, not only by the
 *  browser. A cookie's max-age is the browser's promise, and a copied value
 *  keeps none of it, so the expiry travels inside the signed value too. */
export const UNLOCK_TTL_SECONDS = 60 * 60 * 12;

/** What an unlock was granted against, and so what ends it. */
export interface UnlockGrant {
    /**
     * The stored hash the password was checked against. The hash is salted, so a
     * new password - even the same one set again - is a new hash, and that ends
     * every unlock the old one handed out.
     */
    readonly passwordHash: string | null;
    /** The signed-in user who solved it, when the unlock is theirs rather than
     *  the browser's. Public links have nobody to bind to and leave it out. */
    readonly userId?: string;
}

/** A fingerprint of the password an unlock was granted against. Only ever
 *  signed over, never sent: the cookie carries the expiry and the signature. */
function passwordVersion(passwordHash: string | null): string {
    return createHash("sha256").update(passwordHash ?? "").digest("base64url");
}

/**
 * The message an unlock cookie signs: the kind of link, the link, the password
 * it was solved against, who solved it, and when it stops.
 *
 * Scoped, so a marker for one kind of link can never satisfy another, and
 * encoded as a JSON array so no field can run into the next. This replaced the
 * bare messages shares, drop points and locks signed before (`unlock:<id>`,
 * `drop-unlock:<id>`, `lock-unlock:<id>`), which were kept verbatim for a while
 * so nobody holding a cookie was asked again. They named nothing but the link:
 * the same value for every visitor, honoured for as long as somebody kept it,
 * and still honoured after the owner changed the password to shut them out.
 * Keeping them was the wrong trade. A cookie in the old shape no longer
 * verifies, so whoever solved a password in the last twelve hours is asked for
 * it once more - the only visible effect, and one their cookie's own max-age was
 * at most twelve hours from anyway.
 */
function unlockMessage(scope: string, id: string, grant: UnlockGrant, expiresAt: number): string {
    return JSON.stringify([
        "unlock",
        scope,
        id,
        passwordVersion(grant.passwordHash),
        grant.userId ?? "",
        expiresAt
    ]);
}

/**
 * Sign an opaque marker with the app secret.
 *
 * This is what makes a value the server hands to an anonymous browser - an
 * unlock cookie, a delete token on an uploaded file - unforgeable: only the
 * server, holding POLARIS_AUTH_SECRET, can mint one the serving path accepts.
 * The message names what is being asserted, so a marker minted for one purpose
 * never satisfies another.
 */
export function signMarker(message: string, secret: string): string {
    return createHmac("sha256", secret).update(message).digest("base64url");
}

/** Constant-time check of a presented marker against its expected signature. */
export function verifyMarker(message: string, value: string | undefined, secret: string): boolean {
    if (!value) return false;
    const expected = Buffer.from(signMarker(message, secret));
    const presented = Buffer.from(value);
    if (expected.length !== presented.length) return false;
    return timingSafeEqual(presented, expected);
}

/**
 * Sign the "password solved" marker for one link: `<expiresAt>.<signature>`,
 * the expiry in seconds and inside the signature as well as in front of it.
 */
export function signUnlock(
    scope: string,
    id: string,
    grant: UnlockGrant,
    secret: string,
    now: number = Date.now()
): string {
    const expiresAt = Math.floor(now / 1000) + UNLOCK_TTL_SECONDS;
    return `${expiresAt}.${signMarker(unlockMessage(scope, id, grant, expiresAt), secret)}`;
}

/**
 * Constant-time check of an unlock cookie: signed for this link, against the
 * password it has now, for this user when it was bound to one, and not expired.
 */
export function verifyUnlock(
    scope: string,
    id: string,
    value: string | undefined,
    grant: UnlockGrant,
    secret: string,
    now: number = Date.now()
): boolean {
    if (!value) return false;
    const parts = value.split(".");
    if (parts.length !== 2) return false;
    const [expiry, signature] = parts as [string, string];
    if (!/^\d{1,12}$/.test(expiry)) return false;
    const expiresAt = Number(expiry);
    if (expiresAt * 1000 <= now) return false;
    return verifyMarker(unlockMessage(scope, id, grant, expiresAt), signature, secret);
}
