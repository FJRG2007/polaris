/**
 * The guards every public link answers to.
 *
 * Shares, drop points and access locks each carried their own copy of this logic
 * before it was one module, so the tests that matter are the ones that pin what
 * the merge could quietly have changed: the ORDER the verdicts come back in, and
 * the exact bytes each unlock cookie is signed over. A cookie signed over a new
 * message still verifies against itself - the refactor looks fine - while every
 * visitor who had already solved a password is silently asked again.
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
    /** What the three surfaces signed before they shared one module. */
    const legacy = (message: string) =>
        createHmac("sha256", SECRET).update(message).digest("base64url");

    it("keeps the message every surface already had cookies in the wild for", () => {
        expect(signUnlock("share", ID, SECRET)).toBe(legacy(`unlock:${ID}`));
        expect(signUnlock("drop", ID, SECRET)).toBe(legacy(`drop-unlock:${ID}`));
        expect(signUnlock("lock", ID, SECRET)).toBe(legacy(`lock-unlock:${ID}`));
    });

    it("keeps the cookie names those surfaces already set", () => {
        expect(unlockCookieName("share", ID)).toBe(`polaris_share_${ID}`);
        expect(unlockCookieName("drop", ID)).toBe(`polaris_drop_${ID}`);
        expect(unlockCookieName("lock", ID)).toBe(`polaris_lock_${ID}`);
    });

    it("scopes every new surface, so one marker cannot satisfy another", () => {
        expect(signUnlock("snippet", ID, SECRET)).toBe(legacy(`unlock:snippet:${ID}`));
        expect(verifyUnlock("send", ID, signUnlock("snippet", ID, SECRET), SECRET)).toBe(false);
    });

    it("verifies its own marker and refuses everything else", () => {
        const marker = signUnlock("snippet", ID, SECRET);
        expect(verifyUnlock("snippet", ID, marker, SECRET)).toBe(true);
        expect(verifyUnlock("snippet", ID, marker, "other-secret")).toBe(false);
        expect(verifyUnlock("snippet", "another-id", marker, SECRET)).toBe(false);
        expect(verifyUnlock("snippet", ID, undefined, SECRET)).toBe(false);
        expect(verifyUnlock("snippet", ID, "", SECRET)).toBe(false);
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
