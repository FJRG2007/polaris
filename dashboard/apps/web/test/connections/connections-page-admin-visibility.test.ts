/**
 * Who sees why a provider refused. Setting up a provider app is the
 * administrator's job (CLAUDE.md, "Who configures what"), so the reason it was
 * last refused is read on this personal screen only by whoever can configure
 * integrations - a user who cannot is told nothing more than that the
 * administrators know.
 *
 * Regression covered here: the page used to also offer a user their own
 * Spotify app (`ownApp`); that affordance and the `lastFailure` field now take
 * its place, scoped to `sessionCan(user, "settings.manage")`.
 */

import type { SessionUser } from "@/lib/session";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

let canConfigure = false;
let failureReason: string | undefined;
const capturedProviders: { calls: unknown[] } = { calls: [] };

function user(): SessionUser {
    return {
        id: "user-1",
        email: "user@fixture.test",
        name: "Fixture User",
        isAdmin: false,
        sessionId: "session-1"
    };
}

vi.mock("@/lib/i18n/request", () => ({
    getTranslations: async () => (key: string) => key
}));
vi.mock("@/lib/session", () => ({
    requireUser: async () => user(),
    sessionCan: async () => canConfigure
}));
vi.mock("@/lib/connections/store", () => ({
    listConnections: async () => [],
    connectionLimit: async () => 1,
    connectionSignInAllowed: async () => false
}));
vi.mock("@/lib/presence-activity/lastfm-poll", () => ({ lastfmApiKey: async () => null }));
vi.mock("@/lib/connections/attention", () => ({
    connectionFailure: async (provider: string) =>
        provider === "spotify" && failureReason ? { reason: failureReason } : null
}));
vi.mock("@/lib/connections/oauth", () => ({
    connectionLinkAvailable: async () => false,
    linkScopesSatisfied: () => true,
    missingLinkScopes: () => []
}));
// The view itself is exercised separately (reconnect-affordance.test.tsx); here
// only the providers it is handed are under test, so it is stubbed to capture
// them instead of rendering.
vi.mock("../../src/app/(app)/account/connections/connections-view", () => ({
    ConnectionsView: (props: { providers: unknown[] }) => {
        capturedProviders.calls.push(props.providers);
        return null;
    }
}));

const { default: ConnectionsPage } = await import("../../src/app/(app)/account/connections/page");

function spotifyCard(providers: unknown[]): Record<string, unknown> {
    const card = (providers as Record<string, unknown>[]).find((entry) => entry.slug === "spotify");
    if (!card) throw new Error("no spotify card in providers");
    return card;
}

beforeEach(() => {
    canConfigure = false;
    failureReason = undefined;
    capturedProviders.calls.length = 0;
});

describe("the connections page", () => {
    it("never hands a user who cannot configure integrations a reason, or an app of their own to offer", async () => {
        failureReason = "invalid_client";
        canConfigure = false;

        renderToStaticMarkup(await ConnectionsPage({}));

        const card = spotifyCard(capturedProviders.calls[0] as unknown[]);
        expect(card.lastFailure).toBeUndefined();
        expect(card).not.toHaveProperty("ownApp");
    });

    it("hands whoever can configure integrations the provider's last refusal reason", async () => {
        failureReason = "invalid_client";
        canConfigure = true;

        renderToStaticMarkup(await ConnectionsPage({}));

        const card = spotifyCard(capturedProviders.calls[0] as unknown[]);
        expect(card.lastFailure).toBe("invalid_client");
    });

    it("hands an administrator nothing when there is no refusal on record", async () => {
        failureReason = undefined;
        canConfigure = true;

        renderToStaticMarkup(await ConnectionsPage({}));

        const card = spotifyCard(capturedProviders.calls[0] as unknown[]);
        expect(card.lastFailure).toBeUndefined();
    });
});
