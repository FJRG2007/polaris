/**
 * Typing a Last.fm username on Connected accounts.
 *
 * What is pinned:
 * - the name is checked against the schema both sides share, and then against
 *   Last.fm itself, before anything is stored;
 * - without a deployment key there is nothing to save it for, and the action
 *   says so;
 * - the card never calls the name "not verified": a username is all Last.fm
 *   ever needs, so there is nothing else it could be.
 */

import { withMessages } from "../setup/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const saved: { userId: string; provider: string; label: string }[] = [];
const fake = vi.hoisted(() => ({ key: "key-1" as string | null, asked: [] as string[] }));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));
vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: "user-1", isAdmin: false }) }));
vi.mock("@/lib/device-grace", () => ({ newDeviceRefusal: async () => null }));
vi.mock("@/lib/github-service", () => ({ readGithubAccount: async () => ({}) }));
vi.mock("@/lib/integrations/aws-api", () => ({ awsIdentity: async () => ({}) }));
vi.mock("@/lib/integrations/vercel-api", () => ({ vercelUser: async () => ({}) }));
vi.mock("@/lib/integrations/railway-api", () => ({ railwayAccount: async () => ({}) }));
vi.mock("@/lib/presence-activity/lastfm-poll", () => ({ lastfmApiKey: async () => fake.key }));
vi.mock("@/lib/connections/lastfm", async (original) => {
    const real = await original<typeof import("@/lib/connections/lastfm")>();
    return {
        ...real,
        readLastfmPlaying: async (_key: string, user: string) => {
            fake.asked.push(user);
            if (user === "nobody_here") throw new real.LastfmUnknownUser();
            return null;
        }
    };
});
vi.mock("@/lib/connections/store", () => {
    class ConnectionClaimedError extends Error {}
    class ConnectionLimitError extends Error {}
    class ConnectionVerifiedError extends Error {}
    return {
        ConnectionClaimedError,
        ConnectionLimitError,
        ConnectionVerifiedError,
        deleteConnection: async () => null,
        saveConnection: async () => ({}),
        saveTypedConnection: async (userId: string, provider: string, label: string) => {
            saved.push({ userId, provider, label });
            return { id: "row-1", provider, label, method: "manual" };
        }
    };
});

const { saveLastfmNameAction } = await import("../../src/app/(app)/account/connections/actions");
const { ConnectionsView } = await import(
    "../../src/app/(app)/account/connections/connections-view"
);

type Card = Parameters<typeof ConnectionsView>[0]["providers"][number];

beforeEach(() => {
    saved.length = 0;
    fake.key = "key-1";
    fake.asked = [];
});

describe("saving a Last.fm username", () => {
    it("checks it with Last.fm and stores it trimmed", async () => {
        expect(await saveLastfmNameAction("  example_user ")).toEqual({ name: "example_user" });
        expect(fake.asked).toEqual(["example_user"]);
        expect(saved).toEqual([{ userId: "user-1", provider: "lastfm", label: "example_user" }]);
    });

    it("refuses a name Last.fm does not know, or one that cannot be a name", async () => {
        expect((await saveLastfmNameAction("nobody_here")).error).toMatch(/no account/i);
        expect((await saveLastfmNameAction("has space")).error).toBeTruthy();
        expect((await saveLastfmNameAction({ name: "x" })).error).toBeTruthy();
        expect(saved).toHaveLength(0);
    });

    it("says there is nothing to save it for without a key", async () => {
        fake.key = null;
        expect((await saveLastfmNameAction("example_user")).error).toMatch(/Last\.fm/);
        expect(saved).toHaveLength(0);
    });
});

function lastfm(accounts: Card["accounts"] = []): Card {
    return {
        slug: "lastfm",
        name: "Last.fm",
        category: "general",
        summary: "Show what you are listening to.",
        description: "Type your Last.fm username.",
        acceptsToken: false,
        acceptsTypedName: true,
        typedOnly: true,
        requires: "a Last.fm API key",
        limit: 1,
        canAuthorize: false,
        canSignIn: false,
        accounts,
        ...{}
    };
}

describe("the Last.fm card", () => {
    it("offers to enter a username, and never calls it unverified", () => {
        const empty = renderToStaticMarkup(
            withMessages(<ConnectionsView providers={[lastfm()]} />)
        );
        expect(empty).toContain("Enter your username");
        const linked = renderToStaticMarkup(
            withMessages(
                <ConnectionsView
                    providers={[
                        lastfm([
                            {
                                id: "link-1",
                                provider: "lastfm",
                                label: "example_user",
                                avatarUrl: null,
                                method: "manual",
                                signsIn: false,
                                linkedAt: new Date("2026-09-01T10:00:00.000Z").toISOString()
                            }
                        ])
                    ]}
                />
            )
        );
        expect(linked).toContain("example_user");
        expect(linked).not.toContain("Not verified");
    });
});
