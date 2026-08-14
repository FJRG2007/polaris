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
import { createHmac, timingSafeEqual } from "node:crypto";

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

/**
 * The two messages that were signed before this module existed.
 *
 * They are kept verbatim rather than folded into the scoped form below, because
 * changing the message invalidates every unlock cookie already in a browser -
 * which means everybody who had solved a password gets asked for it again the
 * moment this ships. Nothing else may be added here: a new surface has no
 * cookies in the wild to preserve.
 */
const LEGACY_UNLOCK_MESSAGES: Readonly<Record<string, (id: string) => string>> = {
    share: (id) => `unlock:${id}`,
    drop: (id) => `drop-unlock:${id}`,
    lock: (id) => `lock-unlock:${id}`
};

/** The message the unlock marker signs. Scoped, so a marker for one kind of link
 *  can never satisfy another. */
function unlockMessage(scope: string, id: string): string {
    const legacy = LEGACY_UNLOCK_MESSAGES[scope];
    return legacy ? legacy(id) : `unlock:${scope}:${id}`;
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

/** Sign the "password solved" marker for one link. */
export function signUnlock(scope: string, id: string, secret: string): string {
    return signMarker(unlockMessage(scope, id), secret);
}

/** Constant-time check of an unlock cookie value against its signature. */
export function verifyUnlock(
    scope: string,
    id: string,
    value: string | undefined,
    secret: string
): boolean {
    return verifyMarker(unlockMessage(scope, id), value, secret);
}
