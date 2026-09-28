/**
 * What a link is worth, and what it can never be talked into being worth.
 *
 * A link is the one way into a document that carries no account, so it is the
 * one place where the thing deciding what somebody may do is a string in their
 * own browser. Everything here is about that string: it names one document, it
 * carries its role inside its signature, and neither half can be edited into
 * something better.
 *
 * The failure each of these prevents is the same one - a viewer's link writing -
 * and it is not a failure anybody would see until the document changed.
 */

import { describe, expect, it, vi } from "vitest";

// The signing secret, and nothing else this module reads. Stubbed rather than
// loaded because the point of these tests is the shape of what is signed, not
// which key signed it - and a real environment would make them a test of the
// machine they run on.
vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_AUTH_SECRET: "one-secret-for-every-signature-here" })
}));

// The link row a pass is checked against. Only `findFirst` is read, and each
// test says what it answers.
const findFirst = vi.fn();
vi.mock("@polaris/db", () => ({ prisma: { officeLink: { findFirst } } }));

const links = await import("@/lib/office/links");

const DOC = "01a081bf-94a6-76c1-9907-ab70aa5f6461";
const OTHER = "01a081bf-94a6-76c1-9907-ab70aa5f6462";
const LINK = "01a081bf-94a6-76c1-9907-ab70aa5f6463";
const OTHER_LINK = "01a081bf-94a6-76c1-9907-ab70aa5f6464";

describe("the pass a link hands a browser", () => {
    it("reads back as the role and link it was signed for", () => {
        expect(links.readLinkPass(DOC, links.signLinkPass(DOC, LINK, "viewer", null), null)).toEqual({ role: "viewer", linkId: LINK });
        expect(links.readLinkPass(DOC, links.signLinkPass(DOC, LINK, "editor", null), null)?.role).toBe("editor");
        expect(links.readLinkPass(DOC, links.signLinkPass(DOC, LINK, "commenter", null), null)?.role).toBe("commenter");
    });

    it("cannot be promoted by editing the half in front of the dot", () => {
        // The whole reason the role is inside the signed message rather than
        // beside it. Swapping the word leaves a signature for a different
        // message, and it does not verify.
        const viewer = links.signLinkPass(DOC, LINK, "viewer", null);
        const forged = `editor${viewer.slice(viewer.indexOf("."))}`;
        expect(links.readLinkPass(DOC, forged, null)).toBeNull();
    });

    it("cannot be moved to another link or have its life stretched", () => {
        const [role, , expiry, signature] = links.signLinkPass(DOC, LINK, "editor", null).split(".");
        expect(links.readLinkPass(DOC, [role, OTHER_LINK, expiry, signature].join("."), null)).toBeNull();
        expect(links.readLinkPass(DOC, [role, LINK, String(Number(expiry) + 86_400), signature].join("."), null)).toBeNull();
    });

    it("stops being honoured once it expires, whatever the cookie says", () => {
        const issued = Date.now();
        const pass = links.signLinkPass(DOC, LINK, "editor", null, issued);
        const after = issued + (links.LINK_PASS_TTL_SECONDS + 1) * 1000;
        expect(links.readLinkPass(DOC, pass, null, after)).toBeNull();
    });

    it("opens the document it was signed for and no other", () => {
        expect(links.readLinkPass(OTHER, links.signLinkPass(DOC, LINK, "editor", null), null)).toBeNull();
    });

    it("refuses anything that is not one, rather than guessing", () => {
        expect(links.readLinkPass(DOC, undefined, null)).toBeNull();
        expect(links.readLinkPass(DOC, "", null)).toBeNull();
        expect(links.readLinkPass(DOC, "editor", null)).toBeNull();
        expect(links.readLinkPass(DOC, "editor.", null)).toBeNull();
        expect(links.readLinkPass(DOC, ".signature", null)).toBeNull();
        expect(links.readLinkPass(DOC, "owner.signature", null)).toBeNull();
        expect(links.readLinkPass(DOC, `editor.${LINK}.x.signature`, null)).toBeNull();
    });
});

describe("a pass against the link that issued it", () => {
    it("is worth its role while the link stands", async () => {
        findFirst.mockResolvedValueOnce({ role: "editor", revokedAt: null, expiresAt: null, passwordHash: null });
        expect(await links.linkPassStanding(DOC, links.signLinkPass(DOC, LINK, "editor", null))).toBe("editor");
    });

    it("is worth nothing once the link is revoked", async () => {
        findFirst.mockResolvedValueOnce({ role: "editor", revokedAt: new Date(), expiresAt: null, passwordHash: null });
        expect(await links.linkPassStanding(DOC, links.signLinkPass(DOC, LINK, "editor", null))).toBeNull();
    });

    it("is worth nothing once the link has expired", async () => {
        findFirst.mockResolvedValueOnce({ role: "editor", revokedAt: null, expiresAt: new Date(Date.now() - 1000), passwordHash: null });
        expect(await links.linkPassStanding(DOC, links.signLinkPass(DOC, LINK, "editor", null))).toBeNull();
    });

    it("is worth nothing when the link is gone or names another role", async () => {
        findFirst.mockResolvedValueOnce(null);
        expect(await links.linkPassStanding(DOC, links.signLinkPass(DOC, LINK, "editor", null))).toBeNull();
        findFirst.mockResolvedValueOnce({ role: "viewer", revokedAt: null, expiresAt: null, passwordHash: null });
        expect(await links.linkPassStanding(DOC, links.signLinkPass(DOC, LINK, "editor", null))).toBeNull();
    });

    it("is worth nothing once the link's password has changed", async () => {
        const pass = links.signLinkPass(DOC, LINK, "editor", "scrypt$salt-one$hash-one");
        findFirst.mockResolvedValueOnce({ role: "editor", revokedAt: null, expiresAt: null, passwordHash: "scrypt$salt-one$hash-one" });
        expect(await links.linkPassStanding(DOC, pass)).toBe("editor");
        findFirst.mockResolvedValueOnce({ role: "editor", revokedAt: null, expiresAt: null, passwordHash: "scrypt$salt-two$hash-two" });
        expect(await links.linkPassStanding(DOC, pass)).toBeNull();
    });
});

describe("the cookie a solved password writes", () => {
    const HASH = "scrypt$salt-one$hash-one";

    it("is its own per link, so solving one does not open another", () => {
        expect(links.linkUnlockCookie("one")).not.toBe(links.linkUnlockCookie("two"));
        expect(links.linkUnlocked("one", HASH, links.signLinkUnlock("two", HASH))).toBe(false);
    });

    it("verifies the link it was signed for", () => {
        expect(links.linkUnlocked("one", HASH, links.signLinkUnlock("one", HASH))).toBe(true);
    });

    it("is for the password it was solved against and no other", () => {
        const solved = links.signLinkUnlock("one", HASH);
        expect(links.linkUnlocked("one", "scrypt$salt-two$hash-two", solved)).toBe(false);
    });

    it("is a different namespace from the pass, so one is never the other", () => {
        // Both are signed with the same secret. What keeps a solved password
        // from being read as permission to write is the namespace, not the
        // value.
        expect(links.readLinkPass(DOC, links.signLinkUnlock(DOC, HASH), null)).toBeNull();
        expect(links.linkUnlocked(DOC, HASH, links.signLinkPass(DOC, LINK, "editor", null))).toBe(false);
    });
});

describe("where a link lands", () => {
    it("is the public path, not a path inside the app", () => {
        // Somebody holding one has no account, so a link into `/office` would be
        // a sign-in page with their document behind it.
        expect(links.officeLinkPath("abc")).toBe("/od/abc");
        expect(links.officeLinkPath("abc").startsWith("/office")).toBe(false);
    });
});
