/**
 * A consent screen that grew after people had already linked.
 *
 * `guilds` and `email` were added to Discord's after the first version shipped.
 * Every grant made before that carries the narrower scope, and nothing about it
 * looks wrong: the token still works, the account still shows on the screen with
 * the same name it always did, and the sweep that watches for expired
 * credentials finds nothing to say. What fails is the feature built on the new
 * scope, silently and much later, and it reads as that feature being broken
 * rather than as a consent nobody was ever asked for.
 *
 * The only person who can fix it is the account's owner, and they have no way of
 * knowing. So the grants are measured against what is asked for now, the owner is
 * told once, and the screen they land on says which permission is missing rather
 * than asking them to approve an unspecified "more".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => null,
    getIntegrationSecret: async () => null
}));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example.com" }));
vi.mock("@/lib/connections/store", () => ({ connectionSignInAllowed: async () => false }));
vi.mock("@/lib/connections/proven", () => ({ connectionProven: async () => true }));
vi.mock("@/lib/google-calendar/service", () => ({
    getGoogleOAuthClient: async () => null,
    googleAuthorizeUrl: () => "",
    exchangeGoogleCode: async () => ({}),
    identifyGoogleAccount: async () => ({ accountId: "" }),
    verifyGoogleOAuthClient: async () => null
}));

const { linkScopesSatisfied, missingLinkScopes } = await import("@/lib/connections/oauth");

describe("a link granted before the consent screen grew", () => {
    it("is spotted when it carries none of what was added", () => {
        // What the first Discord links were granted.
        expect(linkScopesSatisfied("discord", "identify")).toBe(false);
        expect(missingLinkScopes("discord", "identify")).toEqual(["email", "guilds"]);
    });

    it("is spotted when it carries only some of it", () => {
        expect(linkScopesSatisfied("discord", "identify email")).toBe(false);
        expect(missingLinkScopes("discord", "identify email")).toEqual(["guilds"]);
    });

    it("is left alone once it carries everything, whatever the order", () => {
        expect(linkScopesSatisfied("discord", "guilds identify email")).toBe(true);
        expect(missingLinkScopes("discord", "guilds identify email")).toEqual([]);
    });

    it("counts a scope the person declined the same as one never asked for", () => {
        // The consent screen asked for three and Discord granted two, because
        // somebody unticked one. The result is identical and so is the fix.
        expect(linkScopesSatisfied("discord", "identify guilds")).toBe(false);
    });

    it("reads a comma-separated grant as well as a space-separated one", () => {
        // Providers differ on the separator and the column stores whatever came
        // back, so a working link must not read as stale over punctuation.
        expect(linkScopesSatisfied("discord", "identify,email,guilds")).toBe(true);
    });

    it("is not confused by a grant that carries more than was asked for", () => {
        expect(linkScopesSatisfied("discord", "identify email guilds connections")).toBe(true);
    });
});

describe("what it refuses to nag anybody about", () => {
    it("says nothing about a provider whose scopes are not this deployment's to set", () => {
        // A GitHub App's user token carries the app's own permissions, so there
        // is no scope list here to have fallen behind.
        expect(linkScopesSatisfied("github", "")).toBe(true);
        expect(missingLinkScopes("github", "")).toEqual([]);
    });

    it("says nothing about a provider it has never heard of", () => {
        // The alternative is telling somebody to re-link an account over a
        // question that was never asked of it.
        expect(linkScopesSatisfied("myspace", "")).toBe(true);
    });

    it("says nothing about Steam, which has no scopes at all", () => {
        expect(linkScopesSatisfied("steam", "")).toBe(true);
    });
});

describe("an empty grant", () => {
    it("counts as missing everything, for a provider that does declare scopes", () => {
        expect(linkScopesSatisfied("discord", "")).toBe(false);
        expect(missingLinkScopes("discord", "")).toEqual(["identify", "email", "guilds"]);
    });
});
