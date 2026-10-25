/**
 * Which services under a scope already sit behind a Polaris login the scope's own
 * rule does not show: a narrower rule switched it on, or an address was made private.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PRIVATE = JSON.stringify({ members: true, allow: [], deny: [] });

interface App {
    id: string;
    name: string;
    environmentId: string;
    environment: { projectId: string; project: { ownerId: string } };
    target: { hostId: string | null };
    domains: { privateAccess: string | null }[];
}

let apps: App[] = [];
/** Rules that require a login, as "scopeType:scopeId". */
let login: string[] = [];
let asked: Record<string, unknown>[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        project: { count: vi.fn(async () => 1) },
        environment: { count: vi.fn(async () => 1) },
        host: { count: vi.fn(async () => 1) },
        hostGroup: { count: vi.fn(async () => 1) },
        application: {
            count: vi.fn(async () => 1),
            findMany: vi.fn(async (args: { take: number; cursor?: { id: string } } & Record<string, unknown>) => {
                asked.push(args);
                const from = args.cursor ? apps.findIndex((row) => row.id === args.cursor!.id) + 1 : 0;
                return apps.slice(from, from + args.take);
            })
        },
        wafRule: {
            findMany: vi.fn(
                async (args: { where: { OR: { scopeType: string; scopeId: { in: string[] } }[] } }) =>
                    args.where.OR.flatMap((clause) =>
                        clause.scopeId.in
                            .filter((id) => login.includes(`${clause.scopeType}:${id}`))
                            .map((scopeId) => ({ scopeType: clause.scopeType, scopeId }))
                    )
            )
        },
        hostGroupMember: {
            findMany: vi.fn(async () => [{ hostId: "host-1", groupId: "group-1" }])
        }
    }
}));
vi.mock("@/lib/setting-store", () => ({ getSetting: vi.fn(async () => null), setSetting: vi.fn(async () => undefined) }));
vi.mock("@/lib/restore-points/service", () => ({ capture: vi.fn(async () => undefined), restoreKeys: {} }));

const { getWafLoginBelow } = await import("@/lib/waf-service");

/** The services named, which is what most of these cases are about. */
const below = async (...args: Parameters<typeof getWafLoginBelow>) => (await getWafLoginBelow(...args)).services;

function app(id: string, environmentId: string, extra: Partial<App> = {}): App {
    return {
        id,
        name: id,
        environmentId,
        environment: { projectId: "project-1", project: { ownerId: "owner" } },
        target: { hostId: "host-1" },
        domains: [],
        ...extra
    };
}

beforeEach(() => {
    apps = [app("web", "env-1"), app("api", "env-1"), app("docs", "env-2")];
    login = [];
    asked = [];
});

describe("services behind a login set below a scope", () => {
    it("names each service a narrower rule or a private address puts behind a login", async () => {
        login = ["environment:env-1"];
        apps[2] = app("docs", "env-2", { domains: [{ privateAccess: PRIVATE }] });
        expect(await below("owner", "project", "project-1")).toEqual([
            { id: "web", name: "web", via: "environment", owned: true },
            { id: "api", name: "api", via: "environment", owned: true },
            { id: "docs", name: "docs", via: "private", owned: true }
        ]);
        expect(asked[0]!.where).toEqual({ environment: { projectId: "project-1" } });
    });

    it("prefers the narrowest rule, since that is the one to open", async () => {
        login = ["environment:env-1", "application:web"];
        const found = await below("owner", "project", "project-1");
        expect(found.find((service) => service.id === "web")?.via).toBe("application");
    });

    it("ignores the scope's own rule and anything above it", async () => {
        login = ["project:project-1", "server:host-1", "server-group:group-1"];
        expect(await below("owner", "project", "project-1")).toEqual([]);
    });

    it("counts a project rule under a server, and a server rule under its group", async () => {
        login = ["project:project-1"];
        expect((await below("owner", "server", "host-1")).map((s) => s.via)).toEqual([
            "project",
            "project",
            "project"
        ]);
        login = ["server:host-1"];
        expect((await below("owner", "server-group", "group-1")).map((s) => s.via)).toEqual([
            "server",
            "server",
            "server"
        ]);
        expect(asked.at(-1)!.where).toEqual({ target: { hostId: { in: ["host-1"] } } });
    });

    it("counts a group rule under the instance-wide scope", async () => {
        login = ["server-group:group-1"];
        expect(await below("owner", "global", "")).toHaveLength(3);
    });

    it("reads a private address on a service's own scope, and an unreadable one as public", async () => {
        apps = [app("web", "env-1", { domains: [{ privateAccess: "{broken" }] })];
        expect(await below("owner", "application", "web")).toEqual([]);
        apps = [app("web", "env-1", { domains: [{ privateAccess: PRIVATE }] })];
        expect(await below("owner", "application", "web")).toEqual([
            { id: "web", name: "web", via: "private", owned: true }
        ]);
    });

    it("has nothing to say for the dashboard's own scope", async () => {
        login = ["application:web"];
        expect(await below("owner", "polaris", "")).toEqual([]);
        expect(asked).toEqual([]);
    });

    it("marks a service someone else owns, so the list does not link to rules the caller cannot open", async () => {
        login = ["application:api"];
        apps[1] = app("api", "env-1", { environment: { projectId: "project-2", project: { ownerId: "someone" } } });
        expect(await below("owner", "global", "")).toEqual([
            { id: "api", name: "api", via: "application", owned: false }
        ]);
    });

    it("counts every service past the first page, and names only the first page", async () => {
        apps = Array.from({ length: 1201 }, (_, index) => app(`app-${String(index).padStart(4, "0")}`, "env-1"));
        login = ["environment:env-1"];
        const view = await getWafLoginBelow("owner", "global", "");
        expect(view.count).toBe(1201);
        expect(view.services).toHaveLength(500);
        expect(asked).toHaveLength(3);
        login = ["application:app-1100", "application:app-1200"];
        expect(await getWafLoginBelow("owner", "global", "")).toEqual({
            count: 2,
            services: [
                { id: "app-1100", name: "app-1100", via: "application", owned: true },
                { id: "app-1200", name: "app-1200", via: "application", owned: true }
            ]
        });
    });
});
