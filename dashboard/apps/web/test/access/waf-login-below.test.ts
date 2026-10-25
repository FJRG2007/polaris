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
    environment: { projectId: string };
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
            findMany: vi.fn(async (args: Record<string, unknown>) => {
                asked.push(args);
                return apps;
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

function app(id: string, environmentId: string, extra: Partial<App> = {}): App {
    return {
        id,
        name: id,
        environmentId,
        environment: { projectId: "project-1" },
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
        expect(await getWafLoginBelow("owner", "project", "project-1")).toEqual([
            { id: "web", name: "web", via: "environment" },
            { id: "api", name: "api", via: "environment" },
            { id: "docs", name: "docs", via: "private" }
        ]);
        expect(asked[0]!.where).toEqual({ environment: { projectId: "project-1" } });
    });

    it("prefers the narrowest rule, since that is the one to open", async () => {
        login = ["environment:env-1", "application:web"];
        const found = await getWafLoginBelow("owner", "project", "project-1");
        expect(found.find((service) => service.id === "web")?.via).toBe("application");
    });

    it("ignores the scope's own rule and anything above it", async () => {
        login = ["project:project-1", "server:host-1", "server-group:group-1"];
        expect(await getWafLoginBelow("owner", "project", "project-1")).toEqual([]);
    });

    it("counts a project rule under a server, and a server rule under its group", async () => {
        login = ["project:project-1"];
        expect((await getWafLoginBelow("owner", "server", "host-1")).map((s) => s.via)).toEqual([
            "project",
            "project",
            "project"
        ]);
        login = ["server:host-1"];
        expect((await getWafLoginBelow("owner", "server-group", "group-1")).map((s) => s.via)).toEqual([
            "server",
            "server",
            "server"
        ]);
        expect(asked.at(-1)!.where).toEqual({ target: { hostId: { in: ["host-1"] } } });
    });

    it("counts a group rule under the instance-wide scope", async () => {
        login = ["server-group:group-1"];
        expect(await getWafLoginBelow("owner", "global", "")).toHaveLength(3);
    });

    it("reads a private address on a service's own scope, and an unreadable one as public", async () => {
        apps = [app("web", "env-1", { domains: [{ privateAccess: "{broken" }] })];
        expect(await getWafLoginBelow("owner", "application", "web")).toEqual([]);
        apps = [app("web", "env-1", { domains: [{ privateAccess: PRIVATE }] })];
        expect(await getWafLoginBelow("owner", "application", "web")).toEqual([
            { id: "web", name: "web", via: "private" }
        ]);
    });

    it("has nothing to say for the dashboard's own scope", async () => {
        login = ["application:web"];
        expect(await getWafLoginBelow("owner", "polaris", "")).toEqual([]);
        expect(asked).toEqual([]);
    });
});
