/**
 * Bringing one's own Spotify app, from the Spotify card.
 *
 * What is pinned:
 * - the pair is validated, then checked with Spotify, before it is stored; a
 *   pair Spotify refuses is never kept;
 * - removing it is one action and only ever the caller's own;
 * - the card offers it whether or not the operator connected an app, and says
 *   which app is in use once there is one - never the secret.
 */

import { withMessages } from "../setup/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    saved: [] as { userId: string; provider: string; clientId: string }[],
    removed: [] as string[],
    accepts: true
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));
vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: "user-1", isAdmin: false }) }));
vi.mock("@/lib/device-grace", () => ({ newDeviceRefusal: async () => null }));
vi.mock("@/lib/github-service", () => ({ readGithubAccount: async () => ({}) }));
vi.mock("@/lib/integrations/aws-api", () => ({ awsIdentity: async () => ({}) }));
vi.mock("@/lib/integrations/vercel-api", () => ({ vercelUser: async () => ({}) }));
vi.mock("@/lib/integrations/railway-api", () => ({ railwayAccount: async () => ({}) }));
vi.mock("@/lib/presence-activity/lastfm-poll", () => ({ lastfmApiKey: async () => null }));
vi.mock("@/lib/connections/store", () => ({
    ConnectionClaimedError: class extends Error {},
    ConnectionLimitError: class extends Error {},
    ConnectionVerifiedError: class extends Error {},
    deleteConnection: async () => null,
    saveConnection: async () => ({}),
    saveTypedConnection: async () => ({})
}));
vi.mock("@/lib/connections/own-oauth-app", async (original) => {
    const real = await original<typeof import("@/lib/connections/own-oauth-app")>();
    return {
        ...real,
        saveOwnOAuthApp: async (userId: string, provider: string, app: { clientId: string }) => {
            fake.saved.push({ userId, provider, clientId: app.clientId });
        },
        removeOwnOAuthApp: async (userId: string) => {
            fake.removed.push(userId);
        }
    };
});
vi.mock("@/lib/connections/spotify", () => ({
    SPOTIFY_PROVIDER: "spotify",
    verifySpotifyClient: async () => fake.accepts
}));

const actions = await import("../../src/app/(app)/account/connections/actions");
const { ConnectionsView } = await import("../../src/app/(app)/account/connections/connections-view");

type Card = Parameters<typeof ConnectionsView>[0]["providers"][number];

const PAIR = { clientId: "0123456789abcdef0123456789abcdef", clientSecret: "fedcba9876543210fedcba9876543210" };

beforeEach(() => {
    fake.saved = [];
    fake.removed = [];
    fake.accepts = true;
});

describe("saving one's own app", () => {
    it("checks it with Spotify and stores it", async () => {
        expect(await actions.saveOwnSpotifyAppAction({ clientId: ` ${PAIR.clientId} `, clientSecret: PAIR.clientSecret })).toEqual({
            clientId: PAIR.clientId
        });
        expect(fake.saved).toEqual([{ userId: "user-1", provider: "spotify", clientId: PAIR.clientId }]);
    });

    it("keeps nothing Spotify refuses or that cannot be a pair", async () => {
        fake.accepts = false;
        expect((await actions.saveOwnSpotifyAppAction(PAIR)).error).toMatch(/Spotify/);
        expect((await actions.saveOwnSpotifyAppAction({ clientId: "short" })).error).toBeTruthy();
        expect((await actions.saveOwnSpotifyAppAction("nonsense")).error).toBeTruthy();
        expect(fake.saved).toEqual([]);
    });

    it("removes only the caller's own", async () => {
        expect(await actions.removeOwnSpotifyAppAction()).toEqual({});
        expect(fake.removed).toEqual(["user-1"]);
    });
});

function spotify(ownApp: Card["ownApp"], canAuthorize = false): Card {
    return {
        slug: "spotify",
        name: "Spotify",
        category: "general",
        summary: "Show what you are listening to.",
        description: "Polaris reads what your Spotify is playing.",
        acceptsToken: false,
        requires: "a Spotify app",
        limit: 1,
        canAuthorize,
        canSignIn: false,
        accounts: [],
        ownApp
    };
}

const VALUES = [{ key: "redirectUri" as const, value: "https://polaris.example.test/api/connections/spotify/callback" }];

describe("the Spotify card", () => {
    it("offers one's own app even where the operator connected none", () => {
        const html = renderToStaticMarkup(withMessages(<ConnectionsView providers={[spotify({ clientId: null, values: VALUES })]} />));
        expect(html).toContain("Use your own Spotify app");
    });

    it("says which app is in use, never the secret", () => {
        const html = renderToStaticMarkup(
            withMessages(<ConnectionsView providers={[spotify({ clientId: PAIR.clientId, values: VALUES }, true)]} />)
        );
        expect(html).toContain("Your own Spotify app");
        expect(html).toContain(PAIR.clientId.slice(0, 8));
        expect(html).not.toContain(PAIR.clientSecret);
    });

    it("reads in Spanish", () => {
        const html = renderToStaticMarkup(
            withMessages(<ConnectionsView providers={[spotify({ clientId: null, values: VALUES })]} />, "es-ES")
        );
        expect(html).toContain("Usar tu propia app de Spotify");
    });
});
