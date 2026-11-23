/**
 * The Code composer lists every repository the person's own GitHub account
 * reaches, not only the ones set up for the review bot, and sets one up the
 * moment it is picked - only after checking that account really reaches it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "0190a000-0000-7000-8000-000000000001";

const db = {
    rows: [] as { id: string; repoFullName: string; enabled: boolean }[],
    upserted: [] as { repoFullName: string; isPrivate: boolean; config: { enabled: boolean } }[]
};
const gh = {
    repos: [] as { fullName: string; defaultBranch: string; private: boolean }[] | null,
    reads: 0,
    gap: null as unknown
};

vi.mock("@polaris/db", () => ({
    prisma: {
        agentRepo: {
            findMany: async ({ where }: { where: { id?: { in: string[] } } }) =>
                where.id ? db.rows.filter((row) => where.id!.in.includes(row.id)) : db.rows,
            findFirst: async ({ where }: { where: { repoFullName: { equals: string } } }) =>
                db.rows.find(
                    (row) => row.repoFullName.toLowerCase() === where.repoFullName.equals.toLowerCase()
                ) ?? null
        }
    }
}));
vi.mock("@/lib/github-access", () => ({
    listReposForUser: async () => {
        gh.reads += 1;
        if (gh.repos === null) throw new Error("GitHub is down");
        return gh.repos;
    }
}));
vi.mock("@/lib/github-app-reach", () => ({ githubInstallGapForRepo: async () => gh.gap }));
vi.mock("@/lib/agents/model-keys", () => ({ providersFor: async () => [] }));
vi.mock("@/lib/agents/model-default", () => ({ firstModelOf: () => "" }));
vi.mock("@/lib/agents/agent-repo-service", () => ({
    defaultConfigFor: async () => ({ advice: [], enabled: true, model: "" }),
    upsertAgentRepo: async (_owner: string, input: (typeof db.upserted)[number]) => {
        db.upserted.push(input);
        return { id: "new-row" };
    }
}));

const { mergeRepoPage, reachableRepoPage, connectSessionRepo, cachedReposForUser } =
    await import("@/lib/agents/reachable-repos");
const { repoOptionsInput } = await import("@/lib/agents/repo-options");
const { githubRepoOf } = await import("@/lib/agents/repo-ref");

const repo = (fullName: string, isPrivate = false) => ({ fullName, defaultBranch: "main", private: isPrivate });

beforeEach(() => {
    db.rows = [];
    db.upserted = [];
    gh.repos = [];
    gh.reads = 0;
    gh.gap = null;
});

describe("mergeRepoPage", () => {
    const request = (over: Record<string, unknown> = {}) => repoOptionsInput.parse(over);

    it("lists GitHub's repositories beside the set-up ones, by name, under the row's id when there is one", () => {
        const page = mergeRepoPage(
            [{ id: "row-web", repoFullName: "acme/web", enabled: true }],
            [repo("acme/zeta"), repo("Acme/Web"), repo("acme/api")],
            request()
        );
        expect(page).toEqual({
            items: [
                { id: "github:acme/api", name: "acme/api" },
                { id: "row-web", name: "acme/web" },
                { id: "github:acme/zeta", name: "acme/zeta" }
            ],
            next: null
        });
    });

    it("keeps an enabled row GitHub no longer lists, and drops a disabled one", () => {
        const page = mergeRepoPage(
            [
                { id: "on", repoFullName: "acme/on", enabled: true },
                { id: "off", repoFullName: "acme/off", enabled: false }
            ],
            [],
            request()
        );
        expect(page.items).toEqual([{ id: "on", name: "acme/on" }]);
    });

    it("searches and pages on the name, continuing after the last one served", () => {
        const github = [repo("acme/a"), repo("acme/b"), repo("acme/c"), repo("other/x")];
        const first = mergeRepoPage([], github, request({ query: " ACME ", limit: 2 }));
        expect(first.items.map((item) => item.name)).toEqual(["acme/a", "acme/b"]);
        expect(first.next).not.toBeNull();
        const second = mergeRepoPage([], github, request({ query: "acme", limit: 2, cursor: first.next }));
        expect(second).toEqual({ items: [{ id: "github:acme/c", name: "acme/c" }], next: null });
    });

    it("reads a cursor it cannot decode as the start", () => {
        expect(mergeRepoPage([], [repo("acme/a")], request({ cursor: "not-a-cursor" })).items).toHaveLength(1);
    });
});

describe("githubRepoOf", () => {
    it("tells a GitHub reference from a row id", () => {
        expect(githubRepoOf("github:acme/web")).toBe("acme/web");
        expect(githubRepoOf("0190a000-0000-7000-8000-000000000001")).toBeNull();
    });
});

describe("reachableRepoPage", () => {
    it("answers ids from the rows alone, without asking GitHub", async () => {
        db.rows = [{ id: OWNER, repoFullName: "acme/web", enabled: false }];
        const page = await reachableRepoPage(OWNER, repoOptionsInput.parse({ ids: [OWNER] }));
        expect(page).toEqual({ items: [{ id: OWNER, name: "acme/web" }], next: null });
        expect(gh.reads).toBe(0);
    });

    it("still lists the set-up repositories while GitHub does not answer", async () => {
        gh.repos = null;
        db.rows = [{ id: "row-web", repoFullName: "acme/web", enabled: true }];
        const page = await reachableRepoPage("down-owner", repoOptionsInput.parse({}));
        expect(page.items).toEqual([{ id: "row-web", name: "acme/web" }]);
    });

    it("reuses one person's GitHub list for a short while", async () => {
        gh.repos = [repo("acme/web")];
        await cachedReposForUser("cached-owner");
        await cachedReposForUser("cached-owner");
        expect(gh.reads).toBe(1);
    });
});

describe("connectSessionRepo", () => {
    it("answers the existing row whatever the casing", async () => {
        db.rows = [{ id: "row-web", repoFullName: "acme/web", enabled: true }];
        expect(await connectSessionRepo(OWNER, "ACME/Web")).toEqual({ id: "row-web", name: "acme/web" });
        expect(db.upserted).toEqual([]);
    });

    it("sets up a reachable repository with the review bot off", async () => {
        gh.repos = [repo("acme/secret", true)];
        expect(await connectSessionRepo(OWNER, "acme/secret")).toEqual({ id: "new-row", name: "acme/secret" });
        expect(db.upserted).toMatchObject([
            { repoFullName: "acme/secret", isPrivate: true, config: { enabled: false } }
        ]);
    });

    it("sets nothing up for a name the person's GitHub does not reach", async () => {
        gh.repos = [repo("acme/web")];
        expect(await connectSessionRepo(OWNER, "someone/else")).toEqual({ kind: "unreachable" });
        const gap = { kind: "repo-not-selected", owner: "acme", repository: "acme/hidden", url: null };
        gh.gap = gap;
        expect(await connectSessionRepo(OWNER, "acme/hidden")).toEqual({ kind: "gap", gap });
        gh.repos = null;
        expect(await connectSessionRepo(OWNER, "acme/web")).toEqual({ kind: "unchecked" });
        expect(db.upserted).toEqual([]);
    });
});
