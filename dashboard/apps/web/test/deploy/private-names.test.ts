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
let envVars: {
    id: string;
    scopeType: string;
    scopeId: string;
    key: string;
    value: string;
    isSecret: boolean;
}[] = [];
let environments: unknown[] = [];
const updates: { table: string; id: string; privateNetwork: string }[] = [];

/** Something saved by someone else between a read and the write made from it. */
let beforeWrite: (() => void) | undefined;

function updater(table: string, rows: () => Row[]) {
    return async ({
        where,
        data
    }: {
        where: { id: string; privateNetwork: string };
        data: { privateNetwork: string };
    }) => {
        const interleaved = beforeWrite;
        beforeWrite = undefined;
        interleaved?.();
        const row = rows().find(
            (one) => one.id === where.id && one.privateNetwork === where.privateNetwork
        );
        if (!row) return { count: 0 };
        updates.push({ table, id: where.id, privateNetwork: data.privateNetwork });
        row.privateNetwork = data.privateNetwork;
        return { count: 1 };
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
            findUnique: async ({ where }: { where: { id: string } }) =>
                applications.find((row) => row.id === where.id) ?? null,
            updateMany: updater("application", () => applications)
        },
        managedDatabase: {
            findMany: inEnvironment(() => databases),
            findUnique: async ({ where }: { where: { id: string } }) =>
                databases.find((row) => row.id === where.id) ?? null,
            updateMany: updater("database", () => databases)
        },
        privateLink: {
            deleteMany: async ({ where }: { where: { id: string } }) => {
                links = links.filter((link) => link.id !== where.id);
                return { count: 1 };
            },
            findMany: async ({ where }: { where?: { OR?: Record<string, string>[] } } = {}) =>
                where?.OR
                    ? links.filter((link) =>
                          where.OR!.some((clause) =>
                              Object.entries(clause).every(
                                  ([key, value]) => link[key as keyof typeof link] === value
                              )
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

/** The networks a link removal took everyone off, and whether the server answers. */
const cut: string[] = [];
let serverAnswers = true;
vi.mock("@/lib/deploy/runtime", () => ({
    getPorts: async () => ({
        cutNetwork: async (name: string) => {
            if (!serverAnswers) throw new Error("connection refused");
            cut.push(name);
        },
        dispose: async () => undefined
    })
}));

const names = await import("@/lib/deploy/private-names");
const { wantedPrivateNetworks } = await import("@/lib/deploy/service-networks");
const deploy = await import("@polaris/deploy");

function daemon(privateNames: boolean): void {
    setCapabilities({
        ...LIMITED_CAPABILITIES,
        edition: "full",
        deploy: true,
        privateNetworks: true,
        privateNames
    });
}

const LOCAL = { kind: "local", hostId: null, runtime: "compose" };
const REMOTE = { kind: "host", hostId: "host-1", runtime: "compose" };

beforeEach(() => {
    applications = [
        { id: "a1", slug: "api", name: "API", environmentId: "env-1", privateNetwork: "{}" },
        {
            id: "a2",
            slug: "web",
            name: "Web",
            environmentId: "env-1",
            privateNetwork: JSON.stringify({ aliases: ["site"] })
        },
        { id: "a3", slug: "api", name: "API", environmentId: "env-2", privateNetwork: "{}" }
    ];
    databases = [
        {
            id: "d1",
            slug: "postgres",
            name: "Postgres",
            environmentId: "env-1",
            privateNetwork: "{}"
        }
    ];
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
        expect(names.privateNameOf({ slug: "api", privateNetwork: '{"name":"backend"}' })).toBe(
            "backend"
        );
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
        expect(names.labelsOf({ slug: "x", privateNetwork: stored }, now)).toEqual([
            "backend",
            "api"
        ]);
    });
});

describe("a deploy's names", () => {
    it("go on the environment's names network, and are only recorded as live when the caller says", async () => {
        const given = await names.prepareDeployNames({
            kind: "application",
            id: "a2",
            slug: "web",
            privateNetwork: applications[1]!.privateNetwork,
            environment: { id: "env-1", networkMode: "environment" },
            projectSlug: "shop",
            target: LOCAL
        });
        const own = deploy.namesNetwork("env-1");
        expect(given.enabled).toBe(true);
        expect(given.domain).toBe("web.polaris.internal");
        expect(given.networkAliases).toEqual({
            [own]: ["web.polaris.internal", "web", "site.polaris.internal", "site"]
        });
        expect(given.live).toContain("web.polaris.internal");
        expect(updates).toHaveLength(0);

        await names.recordLiveNames("application", "a2", given.live, "dep-1");
        const stored = names.parsePrivateNetwork(applications[1]!.privateNetwork);
        expect(stored.live).toEqual({ deploymentId: "dep-1", names: given.live });
        // What was chosen is kept as it is.
        expect(stored.aliases).toEqual(["site"]);
    });

    it("are not given to a release kept beside others, which still joins the networks", async () => {
        links = [{ id: "l1", targetKind: "application", targetId: "a1", sourceId: "other" }];
        const given = await names.prepareDeployNames({
            kind: "application",
            id: "a1",
            slug: "api",
            privateNetwork: "{}",
            environment: { id: "env-1", networkMode: "environment" },
            projectSlug: "shop",
            target: LOCAL,
            kept: true
        });
        expect(given.enabled).toBe(true);
        expect(given.networkAliases).toEqual({});
        expect(given.live).toEqual([]);
        expect(given.domain).toBeNull();
        expect(given.crossLinks).toEqual([deploy.crossLinkNetwork("l1")]);
    });

    it("leave out a name another service of the environment keeps", async () => {
        // An application created after the database, both called `postgres` by their slugs.
        applications.push({
            id: "z9",
            slug: "postgres",
            name: "Postgres app",
            environmentId: "env-1",
            privateNetwork: "{}"
        });
        const app = await names.prepareDeployNames({
            kind: "application",
            id: "z9",
            slug: "postgres",
            privateNetwork: "{}",
            environment: { id: "env-1", networkMode: "environment" },
            projectSlug: "shop",
            target: LOCAL
        });
        expect(app.networkAliases).toEqual({});
        expect(app.domain).toBeNull();
        const database = await names.prepareDeployNames({
            kind: "database",
            id: "d1",
            slug: "postgres",
            privateNetwork: "{}",
            environment: { id: "env-1", networkMode: "environment" },
            projectSlug: "shop",
            target: LOCAL
        });
        expect(database.domain).toBe("postgres.polaris.internal");

        // A name somebody chose wins over one a slug made, whoever came first.
        applications.at(-1)!.privateNetwork = JSON.stringify({ aliases: ["postgres"] });
        expect(
            await names.answeringLabels(
                { kind: "database", id: "d1", slug: "postgres", privateNetwork: "{}" },
                "env-1"
            )
        ).toEqual([]);
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
        expect(given.networkAliases[deploy.crossLinkNetwork("l1")]).toEqual([
            "api.shop.polaris.internal"
        ]);
        expect(given.networkAliases[deploy.namesNetwork("env-1")]).toEqual([
            "api.polaris.internal",
            "api"
        ]);
    });

    it("leave a swarm service off every link's network, which its spec would keep", async () => {
        links = [{ id: "l1", targetKind: "application", targetId: "a1", sourceId: "other" }];
        const given = await names.prepareDeployNames({
            kind: "application",
            id: "a1",
            slug: "api",
            privateNetwork: "{}",
            environment: { id: "env-1", networkMode: "environment" },
            projectSlug: "shop",
            target: { ...REMOTE, runtime: "swarm" }
        });
        expect(given.enabled).toBe(true);
        expect(given.crossLinks).toEqual([]);
        expect(given.networkAliases[deploy.crossLinkNetwork("l1")]).toBeUndefined();
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
        JSON.stringify({
            live: {
                ...(deploymentId ? { deploymentId } : {}),
                names: ["api.polaris.internal", "api"]
            }
        });

    it("switches to the private name only once the release serving it answers to it", () => {
        const container = "shop-api-abcd";
        expect(
            names.referencedDomain(
                { slug: "api", privateNetwork: "{}", currentDeploymentId: "d1" },
                container
            )
        ).toBe(container);
        expect(
            names.referencedDomain(
                { slug: "api", privateNetwork: live("d2"), currentDeploymentId: "d1" },
                container
            )
        ).toBe(container);
        expect(
            names.referencedDomain(
                { slug: "api", privateNetwork: live("d1"), currentDeploymentId: "d1" },
                container
            )
        ).toBe("api.polaris.internal");
        // An application's names recorded against no deployment are never taken as live.
        expect(
            names.referencedDomain(
                { slug: "api", privateNetwork: live(), currentDeploymentId: "d1" },
                container
            )
        ).toBe(container);
        // A renamed service is referenced by its new name once that is live.
        const renamed = JSON.stringify({
            name: "backend",
            live: { names: ["backend.polaris.internal"] }
        });
        expect(names.referencedDomain({ slug: "api", privateNetwork: renamed }, container)).toBe(
            "backend.polaris.internal"
        );
    });

    it("stays on the container name where the target carries no names", () => {
        daemon(false);
        expect(
            names.referencedDomain(
                {
                    slug: "api",
                    privateNetwork: live("d1"),
                    currentDeploymentId: "d1",
                    target: LOCAL
                },
                "shop-api-abcd"
            )
        ).toBe("shop-api-abcd");
    });
});

describe("choosing a name", () => {
    it("is refused when another service of the environment answers to it, in any form", async () => {
        expect((await names.checkPrivateName("application", "a1", "env-1", "Web")).takenBy).toBe(
            "Web"
        );
        expect((await names.checkPrivateName("application", "a1", "env-1", "site")).takenBy).toBe(
            "Web"
        );
        expect(
            (await names.checkPrivateName("application", "a1", "env-1", "postgres")).takenBy
        ).toBe("Postgres");
        // Its own name, and the same name in another environment, are free.
        expect(
            (await names.checkPrivateName("application", "a1", "env-1", "api")).takenBy
        ).toBeNull();
        expect(
            (await names.checkPrivateName("application", "a3", "env-2", "web")).takenBy
        ).toBeNull();
        expect((await names.checkPrivateName("application", "a1", "env-1", "-x")).problem).toBe(
            "edges"
        );
    });

    it("keeps the old name answering for the grace period after a rename", async () => {
        const result = await names.renamePrivateName("application", "a1", " Backend ");
        expect(result).toEqual({ name: "backend", previous: "api" });
        const stored = names.parsePrivateNetwork(applications[0]!.privateNetwork);
        expect(stored.name).toBe("backend");
        expect(stored.former.map((entry) => entry.name)).toEqual(["api"]);
        const days = (Date.parse(stored.former[0]!.until) - Date.now()) / 86_400_000;
        expect(Math.round(days)).toBe(7);
        await expect(names.renamePrivateName("application", "a1", "backend")).rejects.toMatchObject(
            {
                reason: "unchanged"
            }
        );
        await expect(names.renamePrivateName("application", "a1", "web")).rejects.toMatchObject({
            reason: "taken"
        });
    });

    it("checks extra names like names, and drops the service's own", async () => {
        expect(
            await names.setPrivateAliases("application", "a1", ["PaymentsAPI", "api", "paymentsapi"])
        ).toEqual(["paymentsapi"]);
        await expect(names.setPrivateAliases("application", "a1", ["site"])).rejects.toMatchObject({
            reason: "taken"
        });
        await expect(
            names.setPrivateAliases("application", "a1", Array(9).fill("x"))
        ).rejects.toMatchObject({
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
        environments = [
            { id: "env-2", networkMode: "links", applications: [{ id: "a3" }], databases: [] }
        ];
        expect((await wantedPrivateNetworks()).some(deploy.isNamesNetwork)).toBe(false);
    });
});

describe("the canvas lines", () => {
    it("join a service to each service or database its variables reference, inside its environment", async () => {
        envVars = [
            {
                id: "v1",
                scopeType: "application",
                scopeId: "a2",
                key: "API",
                value: "http://${{api.POLARIS_PRIVATE_DOMAIN}}",
                isSecret: false
            },
            {
                id: "v2",
                scopeType: "application",
                scopeId: "a2",
                key: "DB",
                value: "${{postgres.DATABASE_URL}}",
                isSecret: false
            },
            {
                id: "v3",
                scopeType: "application",
                scopeId: "a2",
                key: "AGAIN",
                value: "${{api.PORT}}",
                isSecret: false
            },
            {
                id: "v4",
                scopeType: "application",
                scopeId: "a1",
                key: "SELF",
                value: "${{api.PORT}}",
                isSecret: false
            },
            {
                id: "v5",
                scopeType: "application",
                scopeId: "a3",
                key: "X",
                value: "${{web.PORT}}",
                isSecret: false
            }
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

describe("a release's names", () => {
    const container = "shop-api-abcd";
    const app = () => applications[0]!;

    it("are only held while it deploys, and count as live once it is promoted", async () => {
        await names.stageNames("a1", ["api.polaris.internal", "api"], "dep-2");
        // Deploying, or failed: nothing reads them as live.
        expect(names.parsePrivateNetwork(app().privateNetwork).live).toBeUndefined();
        expect(
            names.referencedDomain(
                { ...app(), currentDeploymentId: "dep-2", target: LOCAL },
                container
            )
        ).toBe(container);

        // A promotion of another deployment leaves them waiting.
        await names.promoteStagedNames("a1", "dep-1");
        expect(names.parsePrivateNetwork(app().privateNetwork).live).toBeUndefined();

        await names.promoteStagedNames("a1", "dep-2");
        const stored = names.parsePrivateNetwork(app().privateNetwork);
        expect(stored.pending).toBeUndefined();
        expect(stored.live).toEqual({
            deploymentId: "dep-2",
            names: ["api.polaris.internal", "api"]
        });
        expect(
            names.referencedDomain(
                { ...app(), currentDeploymentId: "dep-2", target: LOCAL },
                container
            )
        ).toBe("api.polaris.internal");
    });

    it("keep what the serving release was given while a newer one is still deploying", async () => {
        await names.stageNames("a1", ["api.polaris.internal", "api"], "dep-1");
        await names.promoteStagedNames("a1", "dep-1");
        await names.stageNames("a1", ["backend.polaris.internal", "backend"], "dep-2");
        const stored = names.parsePrivateNetwork(app().privateNetwork);
        expect(stored.live?.deploymentId).toBe("dep-1");
        expect(stored.pending?.deploymentId).toBe("dep-2");
    });

    it("stay live across a scale step in place, which carries them to its own deployment", async () => {
        await names.stageNames("a1", ["api.polaris.internal", "api"], "dep-1");
        await names.promoteStagedNames("a1", "dep-1");
        await names.carryLiveNames("a1", "dep-1", "dep-2");
        await names.promoteStagedNames("a1", "dep-2");
        expect(names.parsePrivateNetwork(app().privateNetwork).live).toEqual({
            deploymentId: "dep-2",
            names: ["api.polaris.internal", "api"]
        });
        expect(
            names.referencedDomain(
                { ...app(), currentDeploymentId: "dep-2", target: LOCAL },
                container
            )
        ).toBe("api.polaris.internal");
    });

    it("are recorded without undoing a rename saved at the same moment", async () => {
        await names.stageNames("a1", ["api.polaris.internal", "api"], "dep-1");
        const renamed = JSON.stringify({ ...JSON.parse(app().privateNetwork), name: "backend" });
        // The rename lands between the promotion's read and its write.
        beforeWrite = () => {
            app().privateNetwork = renamed;
        };
        await names.promoteStagedNames("a1", "dep-1");
        const stored = names.parsePrivateNetwork(app().privateNetwork);
        expect(stored.name).toBe("backend");
        expect(stored.live?.deploymentId).toBe("dep-1");
        expect(stored.pending).toBeUndefined();
    });
});

describe("closing a link between projects", () => {
    beforeEach(() => {
        cut.length = 0;
        serverAnswers = true;
        const target = {
            id: "t1",
            kind: "local",
            hostId: null,
            runtime: "compose",
            proxyNetwork: "polaris-proxy"
        };
        Object.assign(databases[0]!, { target, environment: { project: { ownerId: "owner" } } });
        Object.assign(applications[0]!, { target, environment: { project: { ownerId: "owner" } } });
        links = [{ id: "l1", targetKind: "database", targetId: "d1", sourceId: "x9" }];
    });

    it("from a database's side takes everyone off the link's network at once", async () => {
        await names.revokeCrossLink(links[0]!);
        expect(cut).toEqual([deploy.crossLinkNetwork("l1")]);
        expect(links).toEqual([]);
    });

    it("keeps the link on record, and says so, when the server cannot be told", async () => {
        serverAnswers = false;
        await expect(names.revokeCrossLink(links[0]!)).rejects.toMatchObject({
            reason: "unreachable"
        });
        expect(links).toHaveLength(1);
    });

    it("drops the record on a swarm server, whose services never join a link's network", async () => {
        serverAnswers = false;
        const row = databases[0] as unknown as { target: Record<string, unknown> };
        row.target = { ...row.target, runtime: "swarm" };
        await names.revokeCrossLink(links[0]!);
        expect(cut).toEqual([]);
        expect(links).toEqual([]);
    });

    it("only drops the record where nothing could still be on it", async () => {
        // A target already removed has no container on the link.
        await names.revokeCrossLink({ id: "l2", targetKind: "database", targetId: "gone" });
        expect(cut).toEqual([]);
    });
});
