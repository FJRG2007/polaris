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

import * as core from "@polaris/core";
import { ipAllowed } from "@polaris/core";
import { geoAllowedForIp } from "@/lib/geo-service";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** The limits every link carries, whatever it points at. */
export interface LinkLimits {
    revokedAt: Date | null;
    expiresAt: Date | null;
    /** When set, the link is not live yet. */
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
export type LinkDenial =
    | "not_allowed"
    | "outside_hours"
    | "ip_not_allowed"
    | "country_not_allowed"
    | "sign_in_required"
    | "not_invited";

/**
 * The part of the week a link opens in: days as the presence-schedule bitmask
 * (bit 0 Sunday), and minutes past midnight in `timeZone`. Both minutes null is
 * "at any hour" on those days; an end at or before the start crosses midnight.
 */
export type LinkSchedule = core.LinkSchedule;

/**
 * Who may open a link and when, as the columns every link table stores them:
 * `requireLogin` for "only somebody with an account here", `allowedUsers` the
 * JSON list of identities (username or address, or an account id) it opens for,
 * and `linkSchedule` the JSON weekly window, empty for any time. Every field is
 * optional so a table that predates one reads as "no restriction".
 */
export interface LinkPeopleRules {
    requireLogin?: boolean;
    allowedUsers?: string;
    linkSchedule?: string;
}

/** The signed-in account asking, as much of it as an allowlist is matched on. */
export interface LinkViewer {
    id: string;
    email?: string | null;
    username?: string | null;
}

/** Who is asking, resolved only when a rule needs to know. */
export type LinkViewerSource = () => Promise<LinkViewer | null>;

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
    rules: LinkAddressRules,
    ip: string | undefined
): Promise<LinkDenial | null> {
    if (!linkIpAllowed(rules.allowedCidrs, ip)) return "ip_not_allowed";
    if (!(await linkGeoAllowed(rules.allowedCountries, rules.allowedContinents, ip))) {
        return "country_not_allowed";
    }
    return null;
}

/** The address rules a link stores, as the JSON-array columns every link table
 *  uses. Empty means no restriction. */
export interface LinkAddressRules {
    allowedCidrs: string;
    allowedCountries: string;
    allowedContinents: string;
}

/**
 * A stored weekly window read back, or null for "any time". Unparseable reads as
 * null for the same reason a corrupt allowlist reads as empty: it must not be
 * able to lock the owner out of their own link.
 */
export function parseLinkSchedule(json: string | null | undefined): LinkSchedule | null {
    if (!json) return null;
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch {
        return null;
    }
    const parsed = core.linkScheduleSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

/** Whether `now` falls inside a link's weekly window. No window is always. */
export function linkScheduleOpen(schedule: LinkSchedule | null, now: Date = new Date()): boolean {
    if (!schedule) return true;
    return core.grantIsLive(
        { ...schedule, startsAt: null, endsAt: null, maxUses: null, uses: 0 },
        now,
        "UTC"
    );
}

/**
 * Whether a signed-in account is one a link's allowlist names: by its account
 * id, or by its username or address normalized the way they are saved. An
 * empty list is anyone.
 */
export function linkViewerAllowed(viewer: LinkViewer, allowed: readonly string[]): boolean {
    if (allowed.length === 0) return true;
    const ids = new Set(allowed.map((value) => value.trim().toLowerCase()));
    return ids.has(viewer.id.toLowerCase()) || core.userAllowedForRequest(viewer, allowed);
}

/** The signed-in account behind this request, with its username, or null. */
export const sessionLinkViewer: LinkViewerSource = async () => {
    const { guardedUser } = await import("@/lib/session");
    const user = await guardedUser({ touch: false }).catch(() => null);
    if (!user) return null;
    const { prisma } = await import("@polaris/db");
    const row = await prisma.user
        .findUnique({ where: { id: user.id }, select: { username: true } })
        .catch(() => null);
    return { id: user.id, email: user.email, username: row?.username ?? null };
};

/**
 * The account rules, in the order they are checked: an allowlist implies
 * sign-in, so nobody is told "not for your account" before they have said who
 * they are. The viewer is only resolved when a rule needs it.
 */
export async function linkPeopleDenial(
    rules: LinkPeopleRules,
    viewer: LinkViewerSource = sessionLinkViewer
): Promise<LinkDenial | null> {
    const allowed = parseStringList(rules.allowedUsers ?? "[]");
    if (!rules.requireLogin && allowed.length === 0) return null;
    const who = await viewer();
    if (!who) return "sign_in_required";
    return linkViewerAllowed(who, allowed) ? null : "not_invited";
}

/** People rules ready to store, as the columns `LinkPeopleRules` names. */
export function storedPeopleRules(rules: {
    requireLogin?: boolean;
    allowedUsers?: readonly string[];
    schedule?: LinkSchedule | null;
}): { requireLogin: boolean; allowedUsers: string; linkSchedule: string } {
    return {
        requireLogin: rules.requireLogin ?? false,
        allowedUsers: JSON.stringify(rules.allowedUsers ?? []),
        linkSchedule: rules.schedule ? JSON.stringify(rules.schedule) : ""
    };
}

/**
 * Only the start, window and account columns an update names, for a partial
 * write: an absent field keeps what is stored, `null` clears it.
 */
export function peopleRuleChanges(rules: {
    startsAt?: Date | null;
    schedule?: LinkSchedule | null;
    requireLogin?: boolean;
    allowedUsers?: readonly string[];
}): { startsAt?: Date | null; linkSchedule?: string; requireLogin?: boolean; allowedUsers?: string } {
    return {
        ...(rules.startsAt !== undefined ? { startsAt: rules.startsAt } : {}),
        ...(rules.schedule !== undefined
            ? { linkSchedule: rules.schedule ? JSON.stringify(rules.schedule) : "" }
            : {}),
        ...(rules.requireLogin !== undefined ? { requireLogin: rules.requireLogin } : {}),
        ...(rules.allowedUsers !== undefined
            ? { allowedUsers: JSON.stringify(rules.allowedUsers) }
            : {})
    };
}

/** The columns a link's start, window and account rules live in, for a select. */
export const LINK_GUARD_FIELDS = {
    startsAt: true,
    requireLogin: true,
    allowedUsers: true,
    linkSchedule: true
} as const;

/** What a dialog is handed to show a link's start, window and people rules. */
export interface LinkGuardsView {
    startsAt: string | null;
    schedule: LinkSchedule | null;
    requireLogin: boolean;
    allowedUsers: string[];
}

/** Stored people rules and start read back, for a dialog to show. */
export function readLinkGuards(row: LinkPeopleRules & { startsAt?: Date | null }): LinkGuardsView {
    return {
        startsAt: row.startsAt ? row.startsAt.toISOString() : null,
        schedule: parseLinkSchedule(row.linkSchedule),
        requireLogin: row.requireLogin ?? false,
        allowedUsers: parseStringList(row.allowedUsers ?? "[]")
    };
}

/** The one verdict a public route acts on: serve, or the reason it may not. */
export type LinkCheck = LinkUsability | { ok: false; reason: LinkDenial };

/**
 * The single check every public link runs before it serves anything, in this
 * order: whether the link is live (revoked, not started, expired, used up),
 * whether this is one of the hours it opens, whether the caller's address and
 * region are ones it accepts, and then whether it needs an account and whose.
 * Liveness comes first, so a link that is off says so to everyone rather than
 * "not from here"; the account comes last, so nobody is asked to sign in to a
 * link that would refuse them anyway.
 *
 * The password is a separate gate (`verifyUnlock`), because a refused password
 * is a form to fill in rather than a dead end.
 */
export async function checkLink(
    link: { limits: LinkLimits; rules: LinkAddressRules; guards?: LinkPeopleRules },
    ip: string | undefined,
    now: Date = new Date(),
    viewer: LinkViewerSource = sessionLinkViewer
): Promise<LinkCheck> {
    const usable = linkUsability(link.limits, now);
    if (!usable.ok) return usable;
    if (!linkScheduleOpen(parseLinkSchedule(link.guards?.linkSchedule), now)) {
        return { ok: false, reason: "outside_hours" };
    }
    const denial = await linkAddressDenial(link.rules, ip);
    if (denial) return { ok: false, reason: denial };
    const people = link.guards ? await linkPeopleDenial(link.guards, viewer) : null;
    return people ? { ok: false, reason: people } : { ok: true };
}

/** Address rules ready to store: each list as the JSON column it lives in. */
export function storedAddressRules(rules: {
    allowedCidrs?: readonly string[];
    allowedCountries?: readonly string[];
    allowedContinents?: readonly string[];
}): LinkAddressRules {
    return {
        allowedCidrs: JSON.stringify(rules.allowedCidrs ?? []),
        allowedCountries: JSON.stringify(rules.allowedCountries ?? []),
        allowedContinents: JSON.stringify(rules.allowedContinents ?? [])
    };
}

/** Stored address rules read back as lists, for a dialog to show. */
export function readAddressRules(rules: LinkAddressRules): {
    allowedCidrs: string[];
    allowedCountries: string[];
    allowedContinents: string[];
} {
    return {
        allowedCidrs: parseStringList(rules.allowedCidrs),
        allowedCountries: parseStringList(rules.allowedCountries),
        allowedContinents: parseStringList(rules.allowedContinents)
    };
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
export function passwordVersion(passwordHash: string | null): string {
    return createHash("sha256")
        .update(passwordHash ?? "")
        .digest("base64url");
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
