/**
 * The guards every public link answers to.
 *
 * Shares, drop points and access locks each carried their own copy of this logic
 * before it was one module, so the tests that matter are the ones that pin what
 * the merge could quietly have changed: the ORDER the verdicts come back in, and
 * what an unlock cookie is bound to. A cookie that names only its link still
 * verifies against itself - everything looks fine - while it opens the link for
 * anybody it is copied to, forever, and after the password has been changed.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// The geo lookup reaches a service and a cache; the address rules under test are
// the ones that decide without it.
vi.mock("@/lib/geo-service", () => ({
    geoAllowedForIp: vi.fn(async () => true)
}));

const {
    linkIpAllowed,
    linkUsability,
    parseStringList,
    signMarker,
    signUnlock,
    UNLOCK_TTL_SECONDS,
    unlockCookieName,
    verifyMarker,
    verifyUnlock
} = await import("@/lib/link-guards");

const SECRET = "test-secret";
const ID = "0198f0a0-0000-7000-8000-000000000001";
const PAST = new Date("2026-01-01T00:00:00Z");
const NOW = new Date("2026-06-01T00:00:00Z");
const FUTURE = new Date("2026-12-01T00:00:00Z");

const open = { revokedAt: null, expiresAt: null, startsAt: null, maxUses: null, useCount: 0 };

describe("linkUsability", () => {
    it("serves a link with no limits at all", () => {
        expect(linkUsability(open, NOW)).toEqual({ ok: true });
    });

    it("puts revocation above every other verdict", () => {
        // A link that is revoked AND expired AND exhausted reads as revoked: it is
        // the only one of the three somebody chose, so it is the one to report.
        const verdict = linkUsability(
            { revokedAt: PAST, expiresAt: PAST, startsAt: FUTURE, maxUses: 1, useCount: 5 },
            NOW
        );
        expect(verdict).toEqual({ ok: false, reason: "revoked" });
    });

    it("reports a link that has not started yet before it reports it expired", () => {
        const verdict = linkUsability({ ...open, startsAt: FUTURE, expiresAt: PAST }, NOW);
        expect(verdict).toEqual({ ok: false, reason: "scheduled" });
    });

    it("expires exactly at its expiry, not after it", () => {
        expect(linkUsability({ ...open, expiresAt: NOW }, NOW)).toEqual({
            ok: false,
            reason: "expired"
        });
    });

    it("counts a link out once its uses reach the cap", () => {
        expect(linkUsability({ ...open, maxUses: 3, useCount: 2 }, NOW)).toEqual({ ok: true });
        expect(linkUsability({ ...open, maxUses: 3, useCount: 3 }, NOW)).toEqual({
            ok: false,
            reason: "exhausted"
        });
    });
});

describe("parseStringList", () => {
    it("keeps the strings and drops everything else", () => {
        expect(parseStringList('["10.0.0.0/8", 7, null, "ES"]')).toEqual(["10.0.0.0/8", "ES"]);
    });

    it("reads an unparseable or non-array column as no rules", () => {
        expect(parseStringList("not json")).toEqual([]);
        expect(parseStringList('{"a":1}')).toEqual([]);
    });
});

describe("linkIpAllowed", () => {
    it("lets anyone through when no rules are set", () => {
        expect(linkIpAllowed("[]", undefined)).toBe(true);
        expect(linkIpAllowed("broken", "203.0.113.9")).toBe(true);
    });

    it("refuses a caller whose address could not be resolved once rules exist", () => {
        expect(linkIpAllowed('["10.0.0.0/8"]', undefined)).toBe(false);
    });

    it("matches the rules against the address", () => {
        expect(linkIpAllowed('["10.0.0.0/8"]', "10.4.1.7")).toBe(true);
        expect(linkIpAllowed('["10.0.0.0/8"]', "192.168.1.7")).toBe(false);
    });
});

describe("unlock markers", () => {
    /** What the three surfaces signed before this format: the link and nothing
     *  else, the same for every visitor and forever. */
    const legacy = (message: string) =>
        createHmac("sha256", SECRET).update(message).digest("base64url");

    const HASH = "scrypt$salt-one$hash-one";
    const grant = { passwordHash: HASH };
    const T0 = Date.parse("2026-06-01T00:00:00Z");
    const HOUR = 60 * 60 * 1000;

    it("keeps the cookie names those surfaces already set", () => {
        expect(unlockCookieName("share", ID)).toBe(`polaris_share_${ID}`);
        expect(unlockCookieName("drop", ID)).toBe(`polaris_drop_${ID}`);
        expect(unlockCookieName("lock", ID)).toBe(`polaris_lock_${ID}`);
    });

    it("verifies a fresh unlock for the link and password it was signed for", () => {
        for (const scope of ["share", "drop", "lock", "snippet"]) {
            const marker = signUnlock(scope, ID, grant, SECRET, T0);
            expect(verifyUnlock(scope, ID, marker, grant, SECRET, T0 + HOUR)).toBe(true);
        }
    });

    it("carries its expiry in front of the signature, and nothing else", () => {
        const marker = signUnlock("share", ID, grant, SECRET, T0);
        const [expiry, signature] = marker.split(".");
        expect(Number(expiry)).toBe(T0 / 1000 + UNLOCK_TTL_SECONDS);
        expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(marker).not.toContain(HASH);
    });

    it("stops being honoured when it expires, whatever the cookie's own age says", () => {
        const marker = signUnlock("share", ID, grant, SECRET, T0);
        const end = T0 + UNLOCK_TTL_SECONDS * 1000;
        expect(verifyUnlock("share", ID, marker, grant, SECRET, end - 1)).toBe(true);
        expect(verifyUnlock("share", ID, marker, grant, SECRET, end)).toBe(false);
        expect(verifyUnlock("share", ID, marker, grant, SECRET, end + 24 * HOUR)).toBe(false);
    });

    it("cannot have its life stretched by editing the expiry in front", () => {
        const [expiry, signature] = signUnlock("share", ID, grant, SECRET, T0).split(".");
        const stretched = `${Number(expiry) + 86_400}.${signature}`;
        expect(verifyUnlock("share", ID, stretched, grant, SECRET, T0)).toBe(false);
    });

    it("refuses a tampered or malformed value", () => {
        const marker = signUnlock("share", ID, grant, SECRET, T0);
        const flipped = `${marker.slice(0, -1)}${marker.endsWith("A") ? "B" : "A"}`;
        expect(verifyUnlock("share", ID, flipped, grant, SECRET, T0)).toBe(false);
        expect(verifyUnlock("share", ID, `${marker}.x`, grant, SECRET, T0)).toBe(false);
        expect(verifyUnlock("share", ID, `x${marker}`, grant, SECRET, T0)).toBe(false);
        expect(verifyUnlock("share", ID, marker.split(".")[1], grant, SECRET, T0)).toBe(false);
        expect(verifyUnlock("share", ID, undefined, grant, SECRET, T0)).toBe(false);
        expect(verifyUnlock("share", ID, "", grant, SECRET, T0)).toBe(false);
        expect(verifyUnlock("share", ID, marker, grant, "other-secret", T0)).toBe(false);
    });

    it("stops opening once the password changes", () => {
        // The hash is salted, so a new password - even the same one set again -
        // is a new hash, and that is what ends the unlock.
        const marker = signUnlock("share", ID, grant, SECRET, T0);
        const changed = { passwordHash: "scrypt$salt-two$hash-two" };
        expect(verifyUnlock("share", ID, marker, changed, SECRET, T0)).toBe(false);
    });

    it("opens only the link and the kind of link it was signed for", () => {
        const marker = signUnlock("share", ID, grant, SECRET, T0);
        expect(verifyUnlock("share", "another-id", marker, grant, SECRET, T0)).toBe(false);
        expect(verifyUnlock("drop", ID, marker, grant, SECRET, T0)).toBe(false);
        expect(verifyUnlock("lock", ID, marker, grant, SECRET, T0)).toBe(false);
    });

    it("opens only for the user it was bound to, when it was bound to one", () => {
        const mine = { passwordHash: HASH, userId: "user-one" };
        const marker = signUnlock("lock", ID, mine, SECRET, T0);
        expect(verifyUnlock("lock", ID, marker, mine, SECRET, T0)).toBe(true);
        expect(verifyUnlock("lock", ID, marker, { ...mine, userId: "user-two" }, SECRET, T0)).toBe(
            false
        );
        expect(verifyUnlock("lock", ID, marker, grant, SECRET, T0)).toBe(false);
        // And an anonymous one does not become a bound one.
        const anonymous = signUnlock("lock", ID, grant, SECRET, T0);
        expect(verifyUnlock("lock", ID, anonymous, mine, SECRET, T0)).toBe(false);
    });

    it("no longer accepts a cookie in the old shape", () => {
        // Anybody holding one is asked for the password once more - within twelve
        // hours of the moment their browser would have dropped it anyway.
        expect(verifyUnlock("share", ID, legacy(`unlock:${ID}`), grant, SECRET)).toBe(false);
        expect(verifyUnlock("drop", ID, legacy(`drop-unlock:${ID}`), grant, SECRET)).toBe(false);
        expect(verifyUnlock("lock", ID, legacy(`lock-unlock:${ID}`), grant, SECRET)).toBe(false);
        expect(verifyUnlock("snippet", ID, legacy(`unlock:snippet:${ID}`), grant, SECRET)).toBe(
            false
        );
    });
});

describe("signMarker", () => {
    it("verifies a marker only against the message it was minted for", () => {
        const marker = signMarker("drop-del:42", SECRET);
        expect(verifyMarker("drop-del:42", marker, SECRET)).toBe(true);
        expect(verifyMarker("drop-del:43", marker, SECRET)).toBe(false);
    });

    it("refuses a value of the wrong length without comparing it", () => {
        expect(verifyMarker("drop-del:42", "short", SECRET)).toBe(false);
    });
});
