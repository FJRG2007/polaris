/**
 * Private names as they are stored and given out: what a service is called, the
 * names a deploy gives it and where, when a reference switches to the private
 * name, uniqueness inside an environment, a rename's grace period, the networks
 * the reconcile keeps, and the lines the canvas draws.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITED_CAPABILITIES, setCapabilities } from "@polaris/config";

interface Row {
    id: string;
    slug: string;
    name: string;
    environmentId: string;
    privateNetwork: string;
}

let applications: Row[] = [];
let databases: Row[] = [];
let links: { id: string; targetKind: string; targetId: string; sourceId: string }[] = [];
let envVars: { id: string; scopeType: string; scopeId: string; key: string; value: string; isSecret: boolean }[] = [];
let environments: unknown[] = [];
const updates: { table: string; id: string; privateNetwork: string }[] = [];

function updater(table: string, rows: () => Row[]) {
    return async ({ where, data }: { where: { id: string }; data: { privateNetwork: string } }) => {
        updates.push({ table, id: where.id, privateNetwork: data.privateNetwork });
        const row = rows().find((one) => one.id === where.id);
        if (row) row.privateNetwork = data.privateNetwork;
        return row;
    };
}

function inEnvironment(rows: () => Row[]) {
    return async ({ where }: { where: { environmentId?: string | { in: string[] } } }) =>
        rows().filter((row) =>
            typeof where.environmentId === "string"
                ? row.environmentId === where.environmentId
                : where.environmentId?.in.includes(row.environmentId)
        );
}

vi.mock("@polaris/db", () => ({
    prisma: {
        application: {
            findMany: inEnvironment(() => applications),
            findUnique: async ({ where }: { where: { id: string } }) => applications.find((row) => row.id === where.id) ?? null,
            update: updater("application", () => applications)
        },
        managedDatabase: {
            findMany: inEnvironment(() => databases),
            findUnique: async ({ where }: { where: { id: string } }) => databases.find((row) => row.id === where.id) ?? null,
            update: updater("database", () => databases)
        },
        privateLink: {
            findMany: async ({ where }: { where?: { OR?: Record<string, string>[] } } = {}) =>
                where?.OR
                    ? links.filter((link) =>
                          where.OR!.some((clause) =>
                              Object.entries(clause).every(([key, value]) => link[key as keyof typeof link] === value)
                          )
                      )
                    : links
        },
        envVar: {
            findMany: async ({ where }: { where: { scopeId: { in: string[] } } }) =>
                envVars.filter((row) => where.scopeId.in.includes(row.scopeId))
        },
        environment: { findMany: async () => environments }
    }
}));

vi.mock("@polaris/hostd-client", () => ({ HostdClient: class {} }));

const names = await import("@/lib/deploy/private-names");
const { wantedPrivateNetworks } = await import("@/lib/deploy/service-networks");
const deploy = await import("@polaris/deploy");

function daemon(privateNames: boolean): void {
    setCapabilities({ ...LIMITED_CAPABILITIES, edition: "full", deploy: true, privateNetworks: true, privateNames });
}

const LOCAL = { kind: "local", hostId: null };
const REMOTE = { kind: "host", hostId: "host-1" };

beforeEach(() => {
    applications = [
        { id: "a1", slug: "api", name: "API", environmentId: "env-1", privateNetwork: "{}" },
        { id: "a2", slug: "web", name: "Web", environmentId: "env-1", privateNetwork: JSON.stringify({ aliases: ["site"] }) },
        { id: "a3", slug: "api", name: "API", environmentId: "env-2", privateNetwork: "{}" }
    ];
    databases = [{ id: "d1", slug: "postgres", name: "Postgres", environmentId: "env-1", privateNetwork: "{}" }];
    links = [];
    envVars = [];
    environments = [];
    updates.length = 0;
    daemon(true);
});

describe("what is stored", () => {
    it("reads a malformed or old row as nothing chosen", () => {
        expect(names.parsePrivateNetwork("not json")).toEqual({ aliases: [], former: [] });
        expect(names.parsePrivateNetwork('{"name":"Bad Name","aliases":["ok","x y",3]}')).toEqual({
            aliases: ["ok"],
            former: []
        });
        expect(names.privateNameOf({ slug: "api", privateNetwork: "{}" })).toBe("api");
        expect(names.privateNameOf({ slug: "api", privateNetwork: '{"name":"backend"}' })).toBe("backend");
    });

    it("keeps a former name answering only inside its grace period", () => {
        const now = new Date("2026-10-02T00:00:00Z");
        const stored = JSON.stringify({
            name: "backend",
            former: [
                { name: "api", until: "2026-10-05T00:00:00Z" },
                { name: "old", until: "2026-09-01T00:00:00Z" }
            ]
        });
        expect(names.labelsOf({ slug: "x", privateNetwork: stored }, now)).toEqual(["backend", "api"]);
    });
});

describe("a deploy's names", () => {
    it("go on the environment's names network, and are recorded as live for that deployment", async () => {
        const given = await names.prepareDeployNames({
            kind: "application",
            id: "a2",
            slug: "web",
            privateNetwork: applications[1]!.privateNetwork,
            environment: { id: "env-1", networkMode: "environment" },
            projectSlug: "shop",
            target: LOCAL,
            deploymentId: "dep-1"
        });
        const own = deploy.namesNetwork("env-1");
        expect(given.enabled).toBe(true);
        expect(given.domain).toBe("web.polaris.internal");
        expect(given.networkAliases).toEqual({ [own]: ["web.polaris.internal", "web", "site.polaris.internal", "site"] });
        const live = names.parsePrivateNetwork(updates.at(-1)!.privateNetwork).live;
        expect(live?.deploymentId).toBe("dep-1");
        expect(live?.names).toContain("web.polaris.internal");
    });

    it("give a linked service its project-qualified name on the link's network only", async () => {
        links = [{ id: "l1", targetKind: "application", targetId: "a1", sourceId: "other" }];
        const given = await names.prepareDeployNames({
            kind: "application",
            id: "a1",
            slug: "api",
            privateNetwork: "{}",
            environment: { id: "env-1", networkMode: "environment" },
            projectSlug: "shop",
            target: LOCAL
        });
        expect(given.crossLinks).toEqual([deploy.crossLinkNetwork("l1")]);
        expect(given.networkAliases[deploy.crossLinkNetwork("l1")]).toEqual(["api.shop.polaris.internal"]);
        expect(given.networkAliases[deploy.namesNetwork("env-1")]).toEqual(["api.polaris.internal", "api"]);
    });

    it("are off on a machine whose daemon predates them, and on for another server", async () => {
        daemon(false);
        const input = {
            kind: "application" as const,
            id: "a1",
            slug: "api",
            privateNetwork: "{}",
            environment: { id: "env-1", networkMode: "shared" },
            projectSlug: "shop"
        };
        expect((await names.prepareDeployNames({ ...input, target: LOCAL })).enabled).toBe(false);
        expect(updates).toHaveLength(0);
        expect((await names.prepareDeployNames({ ...input, target: REMOTE })).enabled).toBe(true);
    });
});

describe("a reference to a service", () => {
    const live = (deploymentId?: string) =>
        JSON.stringify({ live: { ...(deploymentId ? { deploymentId } : {}), names: ["api.polaris.internal", "api"] } });

    it("switches to the private name only once the release serving it answers to it", () => {
        const container = "shop-api-abcd";
        expect(names.referencedDomain({ slug: "api", privateNetwork: "{}", currentDeploymentId: "d1" }, container)).toBe(
            container
        );
        expect(
            names.referencedDomain({ slug: "api", privateNetwork: live("d2"), currentDeploymentId: "d1" }, container)
        ).toBe(container);
        expect(
            names.referencedDomain({ slug: "api", privateNetwork: live("d1"), currentDeploymentId: "d1" }, container)
        ).toBe("api.polaris.internal");
        // A renamed service is referenced by its new name once that is live.
        const renamed = JSON.stringify({ name: "backend", live: { names: ["backend.polaris.internal"] } });
        expect(names.referencedDomain({ slug: "api", privateNetwork: renamed }, container)).toBe("backend.polaris.internal");
    });

    it("stays on the container name where the target carries no names", () => {
        daemon(false);
        expect(
            names.referencedDomain(
                { slug: "api", privateNetwork: live("d1"), currentDeploymentId: "d1", target: LOCAL },
                "shop-api-abcd"
            )
        ).toBe("shop-api-abcd");
    });
});

describe("choosing a name", () => {
    it("is refused when another service of the environment answers to it, in any form", async () => {
        expect((await names.checkPrivateName("application", "a1", "env-1", "Web")).takenBy).toBe("Web");
        expect((await names.checkPrivateName("application", "a1", "env-1", "site")).takenBy).toBe("Web");
        expect((await names.checkPrivateName("application", "a1", "env-1", "postgres")).takenBy).toBe("Postgres");
        // Its own name, and the same name in another environment, are free.
        expect((await names.checkPrivateName("application", "a1", "env-1", "api")).takenBy).toBeNull();
        expect((await names.checkPrivateName("application", "a3", "env-2", "web")).takenBy).toBeNull();
        expect((await names.checkPrivateName("application", "a1", "env-1", "-x")).problem).toBe("edges");
    });

    it("keeps the old name answering for the grace period after a rename", async () => {
        const result = await names.renamePrivateName("application", "a1", " Backend ");
        expect(result).toEqual({ name: "backend", previous: "api" });
        const stored = names.parsePrivateNetwork(applications[0]!.privateNetwork);
        expect(stored.name).toBe("backend");
        expect(stored.former.map((entry) => entry.name)).toEqual(["api"]);
        const days = (Date.parse(stored.former[0]!.until) - Date.now()) / 86_400_000;
        expect(Math.round(days)).toBe(7);
        await expect(names.renamePrivateName("application", "a1", "backend")).rejects.toMatchObject({
            reason: "unchanged"
        });
        await expect(names.renamePrivateName("application", "a1", "web")).rejects.toMatchObject({ reason: "taken" });
    });

    it("checks extra names like names, and drops the service's own", async () => {
        expect(await names.setPrivateAliases("application", "a1", ["DymoAPI", "api", "dymoapi"])).toEqual(["dymoapi"]);
        await expect(names.setPrivateAliases("application", "a1", ["site"])).rejects.toMatchObject({ reason: "taken" });
        await expect(names.setPrivateAliases("application", "a1", Array(9).fill("x"))).rejects.toMatchObject({
            reason: "tooMany"
        });
    });
});

describe("the networks the reconcile keeps", () => {
    it("adds every environment's names network and each link's, only for a daemon that makes them", async () => {
        environments = [
            { id: "env-1", networkMode: "shared", applications: [{ id: "a1" }], databases: [] },
            { id: "env-2", networkMode: "links", applications: [{ id: "a3" }], databases: [] }
        ];
        links = [{ id: "l1", targetKind: "application", targetId: "a1", sourceId: "a3" }];
        const wanted = await wantedPrivateNetworks();
        expect(wanted).toContain(deploy.namesNetwork("env-1"));
        expect(wanted).toContain(deploy.serviceNamesNetwork("a3"));
        expect(wanted).toContain(deploy.crossLinkNetwork("l1"));
        expect(wanted).not.toContain(deploy.namesNetwork("env-2"));

        daemon(false);
        environments = [{ id: "env-2", networkMode: "links", applications: [{ id: "a3" }], databases: [] }];
        expect((await wantedPrivateNetworks()).some(deploy.isNamesNetwork)).toBe(false);
    });
});

describe("the canvas lines", () => {
    it("join a service to each service or database its variables reference, inside its environment", async () => {
        envVars = [
            { id: "v1", scopeType: "application", scopeId: "a2", key: "API", value: "http://${{api.POLARIS_PRIVATE_DOMAIN}}", isSecret: false },
            { id: "v2", scopeType: "application", scopeId: "a2", key: "DB", value: "${{postgres.DATABASE_URL}}", isSecret: false },
            { id: "v3", scopeType: "application", scopeId: "a2", key: "AGAIN", value: "${{api.PORT}}", isSecret: false },
            { id: "v4", scopeType: "application", scopeId: "a1", key: "SELF", value: "${{api.PORT}}", isSecret: false },
            { id: "v5", scopeType: "application", scopeId: "a3", key: "X", value: "${{web.PORT}}", isSecret: false }
        ];
        const edges = await names.referenceEdges(["env-1", "env-2"]);
        expect(edges.get("env-1")).toEqual([
            { source: "a2", target: "a1" },
            { source: "a2", target: "d1" }
        ]);
        // `web` lives in env-1, so a service of env-2 naming it draws nothing.
        expect(edges.get("env-2")).toBeUndefined();
    });
});
