/**
 * A Redis Cluster once its nodes are up: the steps that join them run in the
 * first node, in order, with the password never in a script or an error; and
 * what somebody connecting to it is told - that it is a cluster, and every node
 * to seed a client with.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const DB = "0192f1e2-7b5c-7d3e-8f00-00000000000a";
const OWNER = "0192f1e2-7b5c-7d3e-8f00-00000000000b";
const ENV = "0192f1e2-7b5c-7d3e-8f00-00000000000c";
const PASSWORD = "cluster-secret-password";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("@polaris/db", () => ({
    prisma: {
        managedDatabase: { findFirst: mocks.findFirst },
        environment: { findFirst: async () => ({ id: ENV }) },
        deployTarget: { findFirst: async () => ({ id: "target-1", runtime: "swarm" }) }
    }
}));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "unused" }) }));
vi.mock("@polaris/storage", () => ({
    encryptCredentials: vi.fn(),
    decryptCredentials: () => ({ username: "polaris", password: PASSWORD, database: "cache" })
}));
vi.mock("@/lib/deploy/runtime", () => ({ getPorts: vi.fn() }));
vi.mock("@/lib/deploy-service", () => ({
    deployLogPath: vi.fn(),
    enqueueOnTarget: vi.fn(),
    executeDeployment: vi.fn(),
    limitsOf: vi.fn()
}));
vi.mock("@/lib/deploy/service-networks", () => ({ networksForService: vi.fn() }));

const { ensureRedisCluster } = await import("../../src/lib/database-ops/redis-cluster");
const { createDatabase, databaseConnection, databaseClusterNodes, deployDatabase } = await import(
    "../../src/lib/database-service"
);

const NODES = databaseClusterNodes({
    engine: "redis",
    containerName: "shop-cache-ab12",
    clusterMasters: 3
})!;

/** A first node that answers each script the way `answer` says, recording them. */
function node(answer: (script: string, call: number) => { code: number; output: string }) {
    const calls: string[][] = [];
    return {
        calls,
        runIn: vi.fn(async (_container: string, argv: readonly string[]) => {
            calls.push([...argv]);
            return answer(argv[4] ?? "", calls.length);
        })
    };
}

const context = {
    container: NODES[0]!,
    admin: { username: "polaris", password: PASSWORD, database: "cache" },
    cluster: NODES
};

describe("the nodes of a cluster", () => {
    it("are the database's own container first, then numbered, six for three masters", () => {
        expect(NODES).toEqual([
            "shop-cache-ab12",
            "shop-cache-ab12-n2",
            "shop-cache-ab12-n3",
            "shop-cache-ab12-n4",
            "shop-cache-ab12-n5",
            "shop-cache-ab12-n6"
        ]);
    });

    it("are none for a single Redis, another engine, or one never deployed", () => {
        expect(
            databaseClusterNodes({ engine: "redis", containerName: "c", clusterMasters: null })
        ).toBeNull();
        expect(
            databaseClusterNodes({ engine: "postgres", containerName: "c", clusterMasters: 3 })
        ).toBeNull();
        expect(
            databaseClusterNodes({ engine: "redis", containerName: "", clusterMasters: 3 })
        ).toBeNull();
    });
});

describe("ensureRedisCluster", () => {
    it("waits for every node, creates the cluster, then waits for it to settle - all inside the first node", async () => {
        let pings = 0;
        const first = node((script) => {
            if (script.includes("PING")) {
                pings += 1;
                return { code: pings === 1 ? 1 : 0, output: "" };
            }
            return {
                code: 0,
                output: script.includes("--cluster create") ? "[OK] All 16384 slots covered." : ""
            };
        });
        await ensureRedisCluster(first, context, async () => undefined);

        const steps = first.calls.map((argv) => {
            const script = argv[4] ?? "";
            if (script.includes("PING")) return "every node answers";
            if (script.includes("--cluster create")) return "create";
            if (script.includes("grep -qx")) return "settled";
            return "report";
        });
        expect(steps).toEqual([
            "every node answers",
            "every node answers",
            "create",
            "settled",
            "report"
        ]);
        for (const [container] of first.runIn.mock.calls) expect(container).toBe("shop-cache-ab12");
        for (const argv of first.calls) {
            expect(argv.slice(0, 4)).toEqual(["env", `REDISCLI_AUTH=${PASSWORD}`, "sh", "-c"]);
            expect(argv.slice(5)).toEqual(["polaris", ...NODES]);
            expect(argv[4]).not.toContain(PASSWORD);
        }
    });

    it("says which step failed, with the password masked out of what it printed", async () => {
        const first = node((script) =>
            script.includes("--cluster create")
                ? { code: 1, output: `[ERR] Node refused AUTH ${PASSWORD}` }
                : { code: 0, output: "" }
        );
        await expect(ensureRedisCluster(first, context, async () => undefined)).rejects.toThrow(
            "Creating the cluster failed: It exited with code 1. [ERR] Node refused AUTH ********"
        );
    });

    it("does nothing for an instance that is not a cluster", async () => {
        const first = node(() => ({ code: 0, output: "" }));
        await ensureRedisCluster(first, { ...context, cluster: null }, async () => undefined);
        expect(first.runIn).not.toHaveBeenCalled();
    });
});

describe("a cluster on a swarm", () => {
    beforeEach(() => mocks.findFirst.mockReset());

    it("is refused when it is asked for, since its nodes are joined by their container names", async () => {
        await expect(
            createDatabase(OWNER, {
                environmentId: ENV,
                name: "cache",
                engine: "redis",
                clusterMasters: 3,
                targetId: "target-1"
            })
        ).rejects.toThrow("deploys through a swarm");
    });

    it("is refused when one is deployed there", async () => {
        mocks.findFirst.mockResolvedValue({
            id: DB,
            slug: "cache",
            engine: "redis",
            clusterMasters: 3,
            parentId: null,
            topology: "single",
            environment: { project: { slug: "shop" } },
            target: { id: "target-1", runtime: "swarm" }
        });
        await expect(deployDatabase(DB, OWNER, OWNER)).rejects.toThrow("deploys through a swarm");
    });
});

describe("connecting to a cluster", () => {
    beforeEach(() => mocks.findFirst.mockReset());

    function row(clusterMasters: number | null) {
        return {
            id: DB,
            slug: "shop-cache",
            engine: "redis",
            containerName: "shop-cache-ab12",
            exposePort: null,
            replicaSet: false,
            clusterMasters,
            parent: null,
            encryptedCredential: Buffer.from("x"),
            credentialNonce: Buffer.from("y"),
            credentialKeyId: "k"
        };
    }

    it("says it is a cluster and lists every node as a seed", async () => {
        mocks.findFirst.mockResolvedValue(row(3));
        const connection = await databaseConnection(DB, OWNER);
        expect(connection.uri).toBe(`redis://:${PASSWORD}@shop-cache-ab12:6379`);
        expect(connection.cluster).toEqual({
            masters: 3,
            nodes: NODES.map((name) => `${name}:6379`),
            reference: "${{shop-cache.REDIS_CLUSTER_NODES}}"
        });
    });

    it("is a plain Redis when it is not one", async () => {
        mocks.findFirst.mockResolvedValue(row(null));
        const connection = await databaseConnection(DB, OWNER);
        expect(connection.cluster).toBeNull();
        expect(connection.reference).toBe("${{shop-cache.DATABASE_URL}}");
    });
});
