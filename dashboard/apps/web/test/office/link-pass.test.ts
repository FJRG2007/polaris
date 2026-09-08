/**
 * The pass a browser carries after solving an office link's password.
 *
 * The role is signed inside the cookie's value, not stored beside it, so the
 * only thing an editor's pass and a viewer's pass have in common is the
 * document id they were minted for. What matters here is the failure that
 * shape prevents: a visitor who was handed a `viewer` link editing the half
 * of the cookie in front of the dot to read `editor` and getting a valid
 * signature back anyway, because the signature was only ever over the
 * document id.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_AUTH_SECRET: "test-secret" }) }));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/storage", () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn() }));
vi.mock("@polaris/core/tokens", () => ({ generateToken: vi.fn(), hashToken: vi.fn() }));
vi.mock("@polaris/core/link-password", () => ({
    hashLinkPassword: vi.fn(),
    verifyLinkPassword: vi.fn()
}));
vi.mock("@/lib/domain-service", () => ({
    sharingBaseUrl: vi.fn(async () => "https://example.com")
}));

const {
    officeLinkPath,
    linkPassCookie,
    linkUnlockCookie,
    signLinkUnlock,
    linkUnlocked,
    signLinkPass,
    readLinkPass
} = await import("@/lib/office/links");

const DOC = "018f2b7a-0000-7000-8000-0000000000d1";
const OTHER_DOC = "018f2b7a-0000-7000-8000-0000000000d2";

describe("officeLinkPath", () => {
    it("builds the address a visitor opens", () => {
        expect(officeLinkPath("tok_abc")).toBe("/od/tok_abc");
    });
});

describe("linkPassCookie and linkUnlockCookie", () => {
    it("are scoped apart, so a share cookie cannot double as an unlock cookie", () => {
        expect(linkPassCookie(DOC)).not.toBe(linkUnlockCookie(DOC));
    });
});

describe("signLinkUnlock / linkUnlocked", () => {
    it("verifies the password an unlock marker was minted for and refuses another link's", () => {
        const marker = signLinkUnlock(DOC);
        expect(linkUnlocked(DOC, marker)).toBe(true);
        expect(linkUnlocked(OTHER_DOC, marker)).toBe(false);
        expect(linkUnlocked(DOC, undefined)).toBe(false);
    });
});

describe("signLinkPass / readLinkPass", () => {
    it("round-trips the role it was signed for", () => {
        const pass = signLinkPass(DOC, "editor");
        expect(readLinkPass(DOC, pass)).toBe("editor");
    });

    it("refuses a pass minted for a different document", () => {
        const pass = signLinkPass(DOC, "editor");
        expect(readLinkPass(OTHER_DOC, pass)).toBeNull();
    });

    it("refuses a pass whose role prefix was edited after signing", () => {
        // A viewer's pass has its own signature, over "...pass:viewer". Swapping
        // the label in front of the dot to "editor" must not verify against it -
        // that would be a viewer link promoting itself to an editor by rewriting
        // a cookie the browser already holds.
        const viewerPass = signLinkPass(DOC, "viewer");
        const dot = viewerPass.indexOf(".");
        const forged = `editor${viewerPass.slice(dot)}`;
        expect(readLinkPass(DOC, forged)).toBeNull();
    });

    it("refuses a value with no role prefix at all", () => {
        expect(readLinkPass(DOC, "not-a-pass")).toBeNull();
        expect(readLinkPass(DOC, undefined)).toBeNull();
    });

    it("refuses a role that is not a real office role", () => {
        expect(readLinkPass(DOC, "owner.somesignature")).toBeNull();
    });
});
