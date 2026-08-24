/**
 * Telling somebody the account they linked has stopped working.
 *
 * A token expires quietly. The screen listing it goes on saying the same login,
 * nothing announces the day it runs out, and the first sign is something else
 * failing for a reason that reads like anything but this - a deploy stopping at
 * the clone with git asking a terminal that does not exist for a username. That
 * is an afternoon spent in the wrong place over something that was knowable
 * weeks earlier.
 *
 * Three rules are what make the announcement worth having rather than noise:
 *
 * **Once.** A sweep every few hours must not be a notification every few hours,
 * so the row records that its owner has been told.
 *
 * **Cleared when it works again.** A renewed token starts over, or the second
 * expiry a year later is the one nobody hears about.
 *
 * **Never for a bad morning.** GitHub being unreachable or rate-limiting is not
 * somebody's token expiring, and announcing it as one teaches them to ignore the
 * announcement that matters.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    userId: string;
    label: string;
    method: string;
    healthNotice: string;
}

const state = {
    rows: [] as Row[],
    credentials: new Map<string, Record<string, unknown> | null>(),
    /** What GitHub does when asked to read the account behind a token. */
    answer: "ok" as "ok" | "unauthorized" | "offline",
    notified: [] as { userId: string; event: string; title: string }[]
};

vi.mock("@polaris/db", () => ({
    prisma: {
        userConnection: {
            findMany: vi.fn(async ({ where }: { where: { userId?: string; provider: string } }) =>
                state.rows.filter((row) => !where.userId || row.userId === where.userId)
            ),
            update: vi.fn(async ({ where, data }: { where: { id: string }; data: { healthNotice?: string } }) => {
                const row = state.rows.find((entry) => entry.id === where.id);
                if (row && data.healthNotice !== undefined) row.healthNotice = data.healthNotice;
                return row;
            })
        }
    }
}));

vi.mock("@/lib/connections/store", () => ({
    readCredential: async (id: string) => state.credentials.get(id) ?? null,
    // Read by oauth.ts, which health.ts now reaches for the scope comparison.
    connectionSignInAllowed: async () => false
}));

vi.mock("@/lib/notifications/dispatch", () => ({
    notify: async (input: { userId: string; event: string; title: string }) => {
        state.notified.push(input);
    }
}));

// The sweep now also measures grants against the scopes each provider asks for,
// which reaches the adapter table - so the modules that table names have to
// answer on import. Only readGithubAccount is exercised here.
vi.mock("@/lib/github-service", () => ({
    readGithubAccount: async () => {
        if (state.answer === "unauthorized") throw new Error("GitHub rejected the token (unauthorized)");
        if (state.answer === "offline") throw new Error("fetch failed");
        return { login: "ana" };
    },
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

const { sweepConnectionHealth } = await import("@/lib/connections/health");

function link(healthNotice = ""): Row {
    const row = { id: "c1", userId: "ana", label: "ana", method: "token", healthNotice };
    state.rows = [row];
    state.credentials.set("c1", { token: "ghp_ana" });
    return row;
}

beforeEach(() => {
    state.rows = [];
    state.credentials.clear();
    state.answer = "ok";
    state.notified = [];
});

describe("a link that has stopped working", () => {
    it("is announced, and names what stopped rather than what failed", async () => {
        const row = link();
        state.answer = "unauthorized";
        await sweepConnectionHealth();
        expect(state.notified).toHaveLength(1);
        expect(state.notified[0]?.event).toBe("account.connection.expired");
        expect(state.notified[0]?.title).toContain("ana");
        expect(row.healthNotice).toBe("expired");
    });

    it("is announced once, however often the sweep runs", async () => {
        link();
        state.answer = "unauthorized";
        await sweepConnectionHealth();
        await sweepConnectionHealth();
        await sweepConnectionHealth();
        expect(state.notified).toHaveLength(1);
    });

    it("starts over once it works again", async () => {
        const row = link("expired");
        state.answer = "ok";
        await sweepConnectionHealth();
        expect(row.healthNotice).toBe("");
        expect(state.notified).toHaveLength(0);

        state.answer = "unauthorized";
        await sweepConnectionHealth();
        expect(state.notified).toHaveLength(1);
    });
});

describe("a link that is fine", () => {
    it("says nothing at all", async () => {
        link();
        await sweepConnectionHealth();
        expect(state.notified).toHaveLength(0);
    });
});

describe("GitHub having a bad morning", () => {
    it("is not somebody's token expiring, and is not announced as one", async () => {
        const row = link();
        state.answer = "offline";
        await sweepConnectionHealth();
        expect(state.notified).toHaveLength(0);
        expect(row.healthNotice).toBe("");
    });

    it("does not clear an expiry already announced, which is still true", async () => {
        const row = link("expired");
        state.answer = "offline";
        await sweepConnectionHealth();
        expect(row.healthNotice).toBe("expired");
        expect(state.notified).toHaveLength(0);
    });
});

describe("a credential that cannot be read at all", () => {
    it("counts as stopped working: never stored, or unreadable after a key rotation", async () => {
        const row = link();
        state.credentials.set("c1", null);
        await sweepConnectionHealth();
        expect(state.notified).toHaveLength(1);
        expect(row.healthNotice).toBe("expired");
    });
});
