/**
 * Which containers the table is sent, and in what order: the filters, the search,
 * the sort and the cut that /api/containers applies before it answers.
 */

import { describe, expect, it, vi } from "vitest";

// The schema's module also authorizes callers; that half is not under test here.
vi.mock("@/lib/session", () => ({ requireUser: vi.fn(), userHasManage: vi.fn() }));
vi.mock("@/lib/docker-service", () => ({
    LOCAL_DOCKER_CONNECTION_ID: "local",
    ownsDockerConnection: vi.fn()
}));

const { listQuerySchema } = await import("@/app/api/containers/query");
import {
    DEFAULT_LIST_QUERY,
    MAX_LIMIT,
    listSearchParams,
    matchesQuery,
    queryContainers,
    stateGroup,
    type ContainerListQuery,
    type ListedContainer
} from "@/app/(app)/apps/containers/container-list";

function row(name: string, overrides: Partial<ListedContainer> = {}): ListedContainer {
    return {
        name,
        image: `example/${name}:1`,
        state: "running",
        polaris: false,
        cpuPercent: null,
        memUsage: null,
        ...overrides
    };
}

const ROWS: ListedContainer[] = [
    row("polaris-web-1", { polaris: true, cpuPercent: 4, memUsage: 400 }),
    row("polaris-postgres-1", {
        polaris: true,
        cpuPercent: 1,
        memUsage: 900,
        image: "postgres:16"
    }),
    row("blog", { cpuPercent: 9, memUsage: 100 }),
    row("cache", { state: "paused" }),
    row("old-job", { state: "exited" }),
    row("worker", { state: "restarting", cpuPercent: 2, memUsage: 50 })
];

function query(overrides: Partial<ContainerListQuery> = {}): ContainerListQuery {
    return { ...DEFAULT_LIST_QUERY, limit: null, ...overrides };
}

const names = (rows: readonly ListedContainer[]) => rows.map((one) => one.name);

describe("state groups", () => {
    it("counts restarting as running and everything that is not up as stopped", () => {
        expect(stateGroup("running")).toBe("running");
        expect(stateGroup("restarting")).toBe("running");
        expect(stateGroup("paused")).toBe("paused");
        for (const state of ["exited", "created", "dead", "removing", "something-new"]) {
            expect(stateGroup(state)).toBe("stopped");
        }
    });
});

describe("filtering", () => {
    it("tells Polaris's own containers from everything else", () => {
        expect(names(queryContainers(ROWS, query({ owner: "polaris" })).rows)).toEqual([
            "polaris-postgres-1",
            "polaris-web-1"
        ]);
        expect(
            queryContainers(ROWS, query({ owner: "other" })).rows.every((one) => !one.polaris)
        ).toBe(true);
    });

    it("filters by state", () => {
        expect(names(queryContainers(ROWS, query({ state: "stopped" })).rows)).toEqual(["old-job"]);
        expect(names(queryContainers(ROWS, query({ state: "paused" })).rows)).toEqual(["cache"]);
        expect(queryContainers(ROWS, query({ state: "running" })).matched).toBe(4);
    });

    it("searches the name and the image, ignoring case and surrounding space", () => {
        expect(names(queryContainers(ROWS, query({ q: "  POSTGRES " })).rows)).toEqual([
            "polaris-postgres-1"
        ]);
        expect(
            matchesQuery(row("api", { image: "ghcr.io/acme/API:2" }), {
                q: "acme/api",
                owner: "all",
                state: "all"
            })
        ).toBe(true);
        expect(queryContainers(ROWS, query({ q: "nothing-like-this" })).matched).toBe(0);
    });

    it("combines every filter", () => {
        const result = queryContainers(ROWS, query({ owner: "other", state: "running", q: "o" }));
        expect(names(result.rows)).toEqual(["blog", "worker"]);
    });
});

describe("ordering", () => {
    it("sorts by CPU busiest first, with unread rows last either way round", () => {
        expect(
            names(queryContainers(ROWS, query({ order: "cpu", direction: "desc" })).rows)
        ).toEqual(["blog", "polaris-web-1", "worker", "polaris-postgres-1", "cache", "old-job"]);
        const ascending = names(
            queryContainers(ROWS, query({ order: "cpu", direction: "asc" })).rows
        );
        expect(ascending.slice(0, 4)).toEqual([
            "polaris-postgres-1",
            "worker",
            "polaris-web-1",
            "blog"
        ]);
        expect(ascending.slice(4)).toEqual(["cache", "old-job"]);
    });

    it("sorts by memory and by state", () => {
        expect(
            names(queryContainers(ROWS, query({ order: "memory", direction: "desc" })).rows).slice(
                0,
                2
            )
        ).toEqual(["polaris-postgres-1", "polaris-web-1"]);
        expect(
            queryContainers(ROWS, query({ order: "state", direction: "asc" })).rows.map(
                (one) => one.state
            )
        ).toEqual(["exited", "paused", "restarting", "running", "running", "running"]);
    });

    it("returns the caller's own rows, not copies with the sort's fields on them", () => {
        const [first] = queryContainers(ROWS, query({ order: "memory" })).rows;
        expect(ROWS).toContain(first);
        expect(first).not.toHaveProperty("memUsedBytes");
    });
});

describe("paging", () => {
    it("cuts to the limit after ordering and says how many matched", () => {
        const result = queryContainers(ROWS, query({ order: "cpu", direction: "desc", limit: 2 }));
        expect(names(result.rows)).toEqual(["blog", "polaris-web-1"]);
        expect(result.matched).toBe(ROWS.length);
    });

    it("never sends more than the ceiling, whatever is asked", () => {
        const many = Array.from({ length: MAX_LIMIT + 50 }, (_, index) => row(`c-${index}`));
        expect(queryContainers(many, query({ limit: MAX_LIMIT + 50 })).rows).toHaveLength(
            MAX_LIMIT
        );
    });

    it("sends every match to a caller that asks for no limit", () => {
        expect(queryContainers(ROWS, query({ limit: null })).rows).toHaveLength(ROWS.length);
    });
});

describe("the request", () => {
    it("round-trips through the route's schema", () => {
        const sent = query({
            q: " web ",
            owner: "polaris",
            state: "running",
            order: "memory",
            direction: "asc",
            limit: 50
        });
        const parsed = listQuerySchema.parse(Object.fromEntries(listSearchParams("local", sent)));
        expect(parsed).toEqual({
            c: "local",
            q: "web",
            owner: "polaris",
            state: "running",
            sort: "memory",
            dir: "asc",
            limit: 50
        });
    });

    it("keeps an older caller's bare request meaning every container, as listed", () => {
        expect(listQuerySchema.parse({ c: "local" })).toEqual({
            c: "local",
            q: "",
            owner: "all",
            state: "all"
        });
        const engineOrder = [row("zeta"), row("alpha")];
        expect(names(queryContainers(engineOrder, query({ order: null })).rows)).toEqual([
            "zeta",
            "alpha"
        ]);
    });

    it("refuses values it does not know and limits past the ceiling", () => {
        expect(listQuerySchema.safeParse({ c: "local", owner: "everyone" }).success).toBe(false);
        expect(listQuerySchema.safeParse({ c: "local", sort: "uptime" }).success).toBe(false);
        expect(
            listQuerySchema.safeParse({ c: "local", limit: String(MAX_LIMIT + 1) }).success
        ).toBe(false);
        expect(listQuerySchema.safeParse({ c: "local", limit: "0" }).success).toBe(false);
    });
});
