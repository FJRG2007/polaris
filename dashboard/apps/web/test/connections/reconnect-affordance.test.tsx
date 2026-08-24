/**
 * Approving a widened consent has to be one click.
 *
 * The regression: a Discord link made before `email` and `guilds` were asked for
 * showed "Needs approving", and the only way to act on it was to disconnect the
 * account and connect it again. Connect is capped by the account limit, which is
 * one by default, so somebody already holding a link was told "Disconnect one to
 * connect another account" - two deliberate actions, the first of them
 * destructive, to grant a permission.
 *
 * Nothing about the round trip needed that. The store upserts on
 * (provider, accountId): an account its owner already holds is refreshed rather
 * than counted again, so authorizing the same one a second time spends no slot
 * and leaves the sign-in choice alone. The gap was the screen, which offered no
 * way to start it.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));
vi.mock("../../src/app/(app)/account/connections/actions", () => ({
    connectGithubTokenAction: async () => ({}),
    disconnectAccountAction: async () => ({})
}));

const { ConnectionsView } = await import("../../src/app/(app)/account/connections/connections-view");

type Card = Parameters<typeof ConnectionsView>[0]["providers"][number];

/** Discord as the screen builds it: one account linked, and the limit reached. */
function card(overrides: Partial<Card> = {}, account: Record<string, unknown> = {}): Card {
    return {
        slug: "discord",
        name: "Discord",
        summary: "Be recognised by the servers that know you by your Discord account.",
        description: "A FiveM server identifies a player by their Discord account.",
        acceptsToken: false,
        requires: "a Discord application",
        limit: 1,
        canAuthorize: true,
        canSignIn: false,
        accounts: [
            {
                id: "link-1",
                provider: "discord",
                label: "TPEO x Little",
                avatarUrl: null,
                method: "oauth",
                signsIn: false,
                needsReauthorization: true,
                missingScopes: ["email", "guilds"],
                linkedAt: new Date("2026-08-24T10:00:00.000Z").toISOString(),
                ...account
            }
        ],
        ...overrides
    } as Card;
}

function markup(entry: Card): string {
    return renderToStaticMarkup(<ConnectionsView providers={[entry]} />);
}

describe("a linked account that needs approving", () => {
    it("offers a way to authorize it again without disconnecting first", () => {
        const html = markup(card());
        expect(html).toContain("Reconnect TPEO x Little to approve what Polaris now asks for");
    });

    it("still says what is missing, so the click is an informed one", () => {
        const html = markup(card());
        expect(html).toContain("Needs approving");
        expect(html).toContain("email, guilds");
    });

    it("stops telling somebody to disconnect one, which is the wrong action here", () => {
        // The sentence that produced the manual dance: true of connecting a
        // different account, useless for the one already listed.
        const html = markup(card());
        expect(html).not.toContain("Disconnect one to connect another account");
        expect(html).toContain("use the reconnect button beside the account above");
    });

    it("offers it even though the account limit is already reached", () => {
        // The limit is what disabled Connect and produced the disconnect-first
        // advice. Re-authorizing an account its owner already holds is not
        // another account, so the cap has nothing to say about it.
        const html = markup(card({ limit: 1 }));
        expect(html).toContain("Reconnect TPEO x Little");
    });
});

describe("a linked account that is fine", () => {
    it("keeps the disconnect-first advice, which is still true for a different account", () => {
        const html = markup(card({}, { needsReauthorization: false, missingScopes: [] }));
        expect(html).toContain("Disconnect one to connect another account");
    });

    it("still offers to authorize again, without dressing it as a warning", () => {
        // Re-authorizing is a real thing to want whenever a grant has gone odd,
        // and the two-step dance was never specific to a widened consent.
        const html = markup(card({}, { needsReauthorization: false, missingScopes: [] }));
        expect(html).toContain("Reconnect TPEO x Little");
        expect(html).not.toContain("Needs approving");
    });
});

describe("what it does not offer it for", () => {
    it("says nothing about reconnecting a pasted token, which has no round trip", () => {
        const html = markup(card({}, { method: "token", needsReauthorization: false }));
        expect(html).not.toContain("Reconnect");
    });

    it("says nothing while the operator has connected no application to authorize against", () => {
        const html = markup(card({ canAuthorize: false }));
        expect(html).not.toContain("Reconnect");
    });
});
