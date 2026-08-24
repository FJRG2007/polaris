/**
 * Telling somebody their linked account needs approving again - once.
 *
 * This runs on a sweep, so the difference between "announced when it changed"
 * and "announced every few hours until they give in" is one comparison against
 * what the row already says. The row is what remembers; the notification is not
 * allowed to be the memory.
 *
 * The other half is not stacking two announcements about one account. An expired
 * link and a link short of a scope both end with "connect it again", and hearing
 * that twice for the same account, for two reasons, is how somebody learns to
 * ignore the one that mattered.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    userId: string;
    provider: string;
    label: string;
    method: string;
    scope: string;
    healthNotice: string;
}

let rows: Row[] = [];
const sent: Array<{ userId: string; event: string; title: string; body: string }> = [];
const updates: Array<{ id: string; data: Record<string, unknown> }> = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        userConnection: {
            findMany: async ({ where }: { where: { provider?: string; method?: string } }) =>
                rows.filter(
                    (row) =>
                        (where.provider === undefined || row.provider === where.provider) &&
                        (where.method === undefined || row.method === where.method)
                ),
            update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
                updates.push({ id: where.id, data });
                const row = rows.find((candidate) => candidate.id === where.id);
                if (row && typeof data.healthNotice === "string") row.healthNotice = data.healthNotice;
                return row;
            }
        }
    }
}));

vi.mock("@/lib/connections/store", () => ({
    readCredential: async () => null,
    // oauth.ts reads this on the way past; nothing here asks about signing in.
    connectionSignInAllowed: async () => false
}));

// health.ts reaches the adapter table through oauth.ts, so every module that
// table names has to answer on import. None of them is exercised: what is under
// test is which links the sweep speaks up about.
vi.mock("@/lib/github-service", () => ({
    readGithubAccount: async () => ({}),
    githubLinkCallbackUrl: (baseUrl: string) => `${baseUrl}/api/integrations/github/link/callback`,
    getGithubUserAuth: async () => null,
    authorizeGithubUser: async () => ({ account: { id: 0, login: "" }, token: {} })
}));
vi.mock("@/lib/google-calendar/service", () => ({
    getGoogleOAuthClient: async () => null,
    googleAuthorizeUrl: () => "",
    exchangeGoogleCode: async () => ({}),
    identifyGoogleAccount: async () => ({ accountId: "" }),
    verifyGoogleOAuthClient: async () => null
}));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => null,
    getIntegrationSecret: async () => null
}));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example.com" }));
vi.mock("@/lib/connections/proven", () => ({ connectionProven: async () => true }));
vi.mock("@/lib/notifications/dispatch", () => ({
    notify: async (input: { userId: string; event: string; title: string; body: string }) => {
        sent.push(input);
    }
}));

const { sweepLinkScopes } = await import("@/lib/connections/health");

/** A Discord link granted before `email` and `guilds` were added to the ask. */
function stale(overrides: Partial<Row> = {}): Row {
    return {
        id: "link-1",
        userId: "ana",
        provider: "discord",
        label: "ana",
        method: "oauth",
        scope: "identify",
        healthNotice: "",
        ...overrides
    };
}

beforeEach(() => {
    rows = [];
    sent.length = 0;
    updates.length = 0;
});

describe("a link short of what is now asked for", () => {
    it("tells its owner, naming what is missing rather than a count", async () => {
        rows = [stale()];
        await sweepLinkScopes();

        expect(sent).toHaveLength(1);
        expect(sent[0]?.userId).toBe("ana");
        expect(sent[0]?.event).toBe("account.connection.scopes");
        expect(sent[0]?.body).toContain("email");
        expect(sent[0]?.body).toContain("guilds");
    });

    it("says plainly that nothing they have has stopped working", async () => {
        rows = [stale()];
        await sweepLinkScopes();
        // The account still works. Wording it as a failure would send somebody
        // looking for what broke.
        expect(sent[0]?.body).toMatch(/nothing you have has stopped working/i);
    });

    it("writes the notice on the row, so the next sweep is silent", async () => {
        rows = [stale()];
        await sweepLinkScopes();
        expect(updates[0]?.data.healthNotice).toBe("scopes");

        sent.length = 0;
        await sweepLinkScopes();
        expect(sent).toHaveLength(0);
    });

    it("goes quiet once the owner has connected it again", async () => {
        rows = [stale({ scope: "identify email guilds", healthNotice: "scopes" })];
        await sweepLinkScopes();

        expect(sent).toHaveLength(0);
        // Cleared, so a scope added later is announced afresh rather than staying
        // quiet because this one was once outstanding.
        expect(updates[0]?.data.healthNotice).toBe("");
    });
});

describe("what it will not announce", () => {
    it("stays quiet about a link that is already known to have expired", async () => {
        // Both end with "connect it again", and they would be two notifications
        // about one account.
        rows = [stale({ healthNotice: "expired" })];
        await sweepLinkScopes();
        expect(sent).toHaveLength(0);
    });

    it("stays quiet about a pasted token, which went through no consent screen", async () => {
        rows = [stale({ method: "token" })];
        await sweepLinkScopes();
        expect(sent).toHaveLength(0);
    });

    it("stays quiet about a provider whose scopes are not this deployment's to set", async () => {
        rows = [stale({ provider: "github", scope: "" })];
        await sweepLinkScopes();
        expect(sent).toHaveLength(0);
    });

    it("stays quiet about a link that already carries everything", async () => {
        rows = [stale({ scope: "identify email guilds" })];
        await sweepLinkScopes();
        expect(sent).toHaveLength(0);
    });
});

describe("more than one person", () => {
    it("tells each owner about their own account and nobody about anybody else's", async () => {
        rows = [
            stale({ id: "link-1", userId: "ana", label: "ana" }),
            stale({ id: "link-2", userId: "bruno", label: "bruno" })
        ];
        await sweepLinkScopes();

        expect(sent.map((entry) => entry.userId).sort()).toEqual(["ana", "bruno"]);
        expect(sent.find((entry) => entry.userId === "ana")?.body).toContain("ana");
        expect(sent.find((entry) => entry.userId === "bruno")?.body).toContain("bruno");
    });
});
