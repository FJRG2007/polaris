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

const links = await import("@/lib/office/links");

const DOC = "01a081bf-94a6-76c1-9907-ab70aa5f6461";
const OTHER = "01a081bf-94a6-76c1-9907-ab70aa5f6462";

describe("the pass a link hands a browser", () => {
    it("reads back as the role it was signed for", () => {
        expect(links.readLinkPass(DOC, links.signLinkPass(DOC, "viewer"))).toBe("viewer");
        expect(links.readLinkPass(DOC, links.signLinkPass(DOC, "editor"))).toBe("editor");
        expect(links.readLinkPass(DOC, links.signLinkPass(DOC, "commenter"))).toBe("commenter");
    });

    it("cannot be promoted by editing the half in front of the dot", () => {
        // The whole reason the role is inside the signed message rather than
        // beside it. Swapping the word leaves a signature for a different
        // message, and it does not verify.
        const viewer = links.signLinkPass(DOC, "viewer");
        const forged = `editor${viewer.slice(viewer.indexOf("."))}`;
        expect(links.readLinkPass(DOC, forged)).toBeNull();
    });

    it("opens the document it was signed for and no other", () => {
        expect(links.readLinkPass(OTHER, links.signLinkPass(DOC, "editor"))).toBeNull();
    });

    it("refuses anything that is not one, rather than guessing", () => {
        expect(links.readLinkPass(DOC, undefined)).toBeNull();
        expect(links.readLinkPass(DOC, "")).toBeNull();
        expect(links.readLinkPass(DOC, "editor")).toBeNull();
        expect(links.readLinkPass(DOC, "editor.")).toBeNull();
        expect(links.readLinkPass(DOC, ".signature")).toBeNull();
        expect(links.readLinkPass(DOC, "owner.signature")).toBeNull();
    });
});

describe("the cookie a solved password writes", () => {
    it("is its own per link, so solving one does not open another", () => {
        expect(links.linkUnlockCookie("one")).not.toBe(links.linkUnlockCookie("two"));
        expect(links.linkUnlocked("one", links.signLinkUnlock("two"))).toBe(false);
    });

    it("verifies the link it was signed for", () => {
        expect(links.linkUnlocked("one", links.signLinkUnlock("one"))).toBe(true);
    });

    it("is a different namespace from the pass, so one is never the other", () => {
        // Both are signed with the same secret. What keeps a solved password
        // from being read as permission to write is the namespace, not the
        // value.
        expect(links.readLinkPass(DOC, links.signLinkUnlock(DOC))).toBeNull();
        expect(links.linkUnlocked(DOC, links.signLinkPass(DOC, "editor"))).toBe(false);
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
