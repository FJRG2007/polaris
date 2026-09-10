/**
 * A Redis Cluster as a managed database: what a request for one may say, what
 * every node runs, the order its creation goes in, and what a service is handed
 * to reach it.
 *
 * The scripts run inside a node's container and cannot be run here, so what is
 * pinned is what they are given: the node names as positional arguments and the
 * password in the environment, never inside the script, and the documented
 * cluster flags on every node.
 */

import { describe, expect, it } from "vitest";
import {
    databaseCreateSchema,
    databaseReferenceKeys,
    redisClusterExec,
    redisClusterNodeCount,
    redisClusterSeeds,
    redisClusterServerCommand,
    redisClusterSetupSteps,
    runPrepareSteps,
    type PrepareExecResult
} from "../src/index.js";

const ENV = "0192f1e2-7b5c-7d3e-8f00-000000000001";
const NODES = ["cache-ab12", "cache-ab12-n2", "cache-ab12-n3", "cache-ab12-n4", "cache-ab12-n5", "cache-ab12-n6"];

describe("a request for a cluster", () => {
    const base = { environmentId: ENV, name: "cache", engine: "redis" as const };

    it("accepts 3, 5 or 7 masters", () => {
        for (const clusterMasters of [3, 5, 7]) {
            expect(databaseCreateSchema.safeParse({ ...base, clusterMasters }).success).toBe(true);
        }
    });

    it("refuses any other count", () => {
        for (const clusterMasters of [0, 1, 2, 4, 6, 8, 3.5]) {
            expect(databaseCreateSchema.safeParse({ ...base, clusterMasters }).success).toBe(false);
        }
    });

    it("is a single instance when no count is given", () => {
        const parsed = databaseCreateSchema.parse(base);
        expect(parsed.clusterMasters).toBeUndefined();
    });

    it("is refused for an engine that is not Redis", () => {
        const result = databaseCreateSchema.safeParse({ ...base, engine: "postgres", clusterMasters: 3 });
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.path).toEqual(["clusterMasters"]);
    });

    it("cannot be published on one port", () => {
        const result = databaseCreateSchema.safeParse({ ...base, clusterMasters: 3, exposePort: 6380 });
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.path).toEqual(["exposePort"]);
    });
});

describe("a node's command", () => {
    it("adds the cluster settings, with the password as masterauth too", () => {
        const command = redisClusterServerCommand("s3cret-password", "default", undefined, "cache-ab12-n2");
        expect(command.slice(0, 3)).toEqual(["redis-server", "--requirepass", "s3cret-password"]);
        const flag = (name: string) => command[command.indexOf(name) + 1];
        expect(flag("--masterauth")).toBe("s3cret-password");
        expect(flag("--cluster-enabled")).toBe("yes");
        expect(flag("--cluster-config-file")).toBe("nodes.conf");
        expect(flag("--cluster-node-timeout")).toBe("5000");
        expect(flag("--cluster-announce-hostname")).toBe("cache-ab12-n2");
        expect(flag("--cluster-preferred-endpoint-type")).toBe("hostname");
    });

    it("keeps the mode's own settings", () => {
        const command = redisClusterServerCommand("s3cret-password", "cache", 512, "cache-ab12");
        expect(command).toContain("--maxmemory");
        expect(command).toContain("512mb");
        expect(command).toContain("--cluster-enabled");
    });

    it("refuses a hostname Redis could not announce", () => {
        expect(() => redisClusterServerCommand("pw-long-enough", "default", undefined, "bad name")).toThrow();
    });
});

describe("creating the cluster", () => {
    it("runs twice as many nodes as masters", () => {
        expect([3, 5, 7].map(redisClusterNodeCount)).toEqual([6, 10, 14]);
    });

    it("hands the nodes over as arguments and the password in the environment", () => {
        const [step] = redisClusterSetupSteps(3);
        const argv = redisClusterExec("s3cret-password", step!.command, NODES);
        expect(argv.slice(0, 4)).toEqual(["env", "REDISCLI_AUTH=s3cret-password", "sh", "-c"]);
        expect(argv.slice(5)).toEqual(["polaris", ...NODES]);
        for (const node of NODES) expect(argv[4]).not.toContain(node);
        expect(argv[4]).not.toContain("s3cret-password");
    });

    it("refuses a node name that is not one", () => {
        expect(() => redisClusterExec("pw", "true", ["cache", "x; rm -rf /"])).toThrow();
    });

    it("creates with a replica for every master, answering yes itself", () => {
        const [create] = redisClusterSetupSteps(3);
        expect(create!.command).toContain("redis-cli --no-auth-warning --cluster create");
        expect(create!.command).toContain("--cluster-replicas 1 --cluster-yes");
        // CLUSTER MEET takes an address, so names are resolved first.
        expect(create!.command).toContain("getent hosts");
        // Every node has to answer before it is created.
        expect(create!.readiness.test).toContain("PING");
    });

    it("waits for every node, then creates, then waits for the cluster to settle", async () => {
        const steps = redisClusterSetupSteps(3);
        const ran: string[] = [];
        let pings = 0;
        const exec = async (script: string): Promise<PrepareExecResult> => {
            if (script === steps[0]!.readiness.test) {
                pings += 1;
                ran.push(`ping ${pings}`);
                // The third node is still starting for the first two checks.
                return { code: pings < 3 ? 1 : 0, output: "" };
            }
            if (script === steps[0]!.command) {
                ran.push("create");
                return { code: 0, output: "[OK] All 16384 slots covered." };
            }
            if (script === steps[1]!.readiness.test) {
                ran.push("settled");
                return { code: 0, output: "" };
            }
            ran.push("check");
            return { code: 0, output: "cluster_state:ok" };
        };
        const outcomes = await runPrepareSteps(steps, exec, async () => undefined);
        expect(ran).toEqual(["ping 1", "ping 2", "ping 3", "create", "settled", "check"]);
        expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true]);
    });

    it("never creates when the nodes do not all answer", async () => {
        const steps = redisClusterSetupSteps(3);
        let created = false;
        const outcomes = await runPrepareSteps(
            steps,
            async (script) => {
                if (script === steps[0]!.command) created = true;
                return { code: 1, output: "" };
            },
            async () => undefined
        );
        expect(created).toBe(false);
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]!.ok).toBe(false);
    });

    it("waits for as many nodes as the cluster has", () => {
        expect(redisClusterSetupSteps(5)[1]!.readiness.test).toContain("cluster_known_nodes:10");
        expect(redisClusterSetupSteps(7)[1]!.readiness.test).toContain("cluster_known_nodes:14");
    });
});

describe("reaching the cluster", () => {
    it("gives every node as a seed", () => {
        expect(redisClusterSeeds(NODES.slice(0, 2))).toEqual(["cache-ab12:6379", "cache-ab12-n2:6379"]);
    });

    it("adds the node list to a cluster's reference keys", () => {
        const keys = databaseReferenceKeys({
            engine: "redis",
            host: "cache-ab12",
            port: 6379,
            database: "",
            username: "polaris",
            password: "pw",
            uri: "redis://:pw@cache-ab12:6379",
            clusterNodes: redisClusterSeeds(NODES)
        });
        expect(keys.REDIS_URL).toBe("redis://:pw@cache-ab12:6379");
        expect(keys.REDIS_CLUSTER_NODES).toBe(NODES.map((node) => `${node}:6379`).join(","));
    });

    it("has no node list for a single instance", () => {
        const keys = databaseReferenceKeys({
            engine: "redis",
            host: "cache-ab12",
            port: 6379,
            database: "",
            username: "polaris",
            password: "pw",
            uri: "redis://:pw@cache-ab12:6379"
        });
        expect(keys.REDIS_CLUSTER_NODES).toBeUndefined();
    });
});
