/**
 * A database laid out over several containers, end to end short of the
 * containers themselves: what each member is deployed with, the order its
 * members are joined in - read off a fake server that answers the way the
 * engines do - the connection strings it hands out, and a rolling upgrade's
 * order. No engine runs here; what is pinned is exactly what would be run.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbComposeSpec, forCompose, renderComposeYaml } from "@polaris/deploy";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), decrypt: vi.fn() }));

vi.mock("@polaris/db", () => ({ prisma: { managedDatabase: { findFirst: mocks.findFirst } } }));
vi.mock("@polaris/storage", () => ({ decryptCredentials: mocks.decrypt, encryptCredentials: vi.fn() }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k" }) }));
vi.mock("@/lib/deploy/runtime", () => ({ getPorts: vi.fn() }));
vi.mock("@/lib/deploy-service", () => ({
    deployLogPath: vi.fn(),
    enqueueOnTarget: vi.fn(),
    executeDeployment: vi.fn(),
    limitsOf: vi.fn()
}));
vi.mock("@/lib/deploy/service-networks", () => ({ networksForService: vi.fn() }));

const { topologyMemberPlans } = await import("../../src/lib/database-topology");
const { ensureTopology, rollMembers } = await import("../../src/lib/database-ops/topology");
const { databaseConnection } = await import("../../src/lib/database-service");

const NAME = "shop-orders-1a2b";
const ADMIN = { username: "polaris", password: "adminSecret-456" };
const KEY = "ab".repeat(384);

/** A clock that moves only when something waits on it. */
function pace() {
    let now = 0;
    return {
        readyMs: 10_000,
        settleMs: 10_000,
        gapMs: 1000,
        now: () => now,
        wait: async (ms: number) => {
            now += ms;
        }
    };
}

/** What a MongoDB command asks, from the script it evaluates. */
function kindOf(argv: readonly string[]): string {
    const script = argv.at(-1) ?? "";
    if (script.includes("ping: 1")) return "ping";
    if (script.includes("connectionStatus")) return "sign-in";
    if (script.includes("rs.initiate")) return "initiate";
    if (script.includes("db.hello()")) return "role";
    if (script.includes("createUser")) return "create-root";
    if (script.includes("listShards")) return "add-shards";
    if (script.includes("SHOW REPLICA STATUS")) return "replica-status";
    if (script.includes("CHANGE REPLICATION SOURCE")) return "follow";
    if (script.includes("super_read_only")) return "read-only";
    if (script.includes("GRANT REPLICATION SLAVE")) return "replication-user";
    if (argv.includes("mysqladmin")) return "mysql-ready";
    return "unknown";
}

/**
 * A server whose MongoDB members start with no users, gain one when it is
 * created, and are primary once initiated - enough of the engine's behaviour
 * for the order of the steps to matter.
 */
function mongoServer(options: { usersFrom?: readonly string[] } = {}) {
    const calls: { container: string; kind: string; argv: readonly string[] }[] = [];
    const users = new Set(options.usersFrom ?? []);
    const initiated = new Set<string>();
    const runIn = vi.fn(async (container: string, argv: readonly string[]) => {
        const kind = kindOf(argv);
        calls.push({ container, kind, argv });
        const signedIn = argv.includes("-u");
        switch (kind) {
            case "sign-in":
                return { code: users.has(container) ? 0 : 1, output: users.has(container) ? "1" : "MongoServerError: Authentication failed." };
            case "initiate":
                if (signedIn && !users.has(container)) return { code: 1, output: "Authentication failed." };
                initiated.add(container);
                return { code: 0, output: "1" };
            case "role":
                return { code: 0, output: initiated.has(container) ? "primary" : "other" };
            case "create-root":
                users.add(container);
                return { code: 0, output: "1" };
            default:
                return { code: 0, output: "1" };
        }
    });
    return { calls, runIn };
}

beforeEach(() => {
    mocks.findFirst.mockReset();
    mocks.decrypt.mockReset();
});

describe("what each member is deployed with", () => {
    it("gives a replica set's first member the image's first-start account, and every member the key", () => {
        const members = topologyMemberPlans({
            topology: { kind: "replicaSet", members: 3 },
            name: NAME,
            volumeName: "mongo-data-1a2b",
            engineEnv: { MONGO_INITDB_ROOT_USERNAME: "polaris", MONGO_INITDB_ROOT_PASSWORD: "pw" },
            password: "pw",
            clusterKey: KEY
        })!;
        expect(members.map((member) => member.name)).toEqual([NAME, `${NAME}-m2`, `${NAME}-m3`]);
        expect(members[0]!.env).toEqual({ MONGO_INITDB_ROOT_USERNAME: "polaris", MONGO_INITDB_ROOT_PASSWORD: "pw", POLARIS_MONGO_KEY: KEY });
        // The others hold no data before the set is initiated, which initiation requires.
        expect(members[1]!.env).toEqual({ POLARIS_MONGO_KEY: KEY });
        expect(members.map((member) => member.volumeName)).toEqual(["mongo-data-1a2b", "mongo-data-1a2b-m2", "mongo-data-1a2b-m3"]);
    });

    it("creates no account on a sharded cluster's members, and publishes only its router", () => {
        const members = topologyMemberPlans({
            topology: { kind: "sharded", shards: 2 },
            name: NAME,
            volumeName: "v",
            engineEnv: { MONGO_INITDB_ROOT_USERNAME: "polaris" },
            password: "pw",
            clusterKey: KEY,
            exposePort: 27018
        })!;
        expect(members).toHaveLength(10);
        expect(members.every((member) => !("MONGO_INITDB_ROOT_USERNAME" in member.env))).toBe(true);
        expect(members.filter((member) => member.exposePort !== undefined).map((member) => member.name)).toEqual([NAME]);
        expect(members[0]!.volumeName).toBeUndefined();
    });

    it("moves only the members a rolling upgrade has reached", () => {
        const members = topologyMemberPlans({
            topology: { kind: "replicaSet", members: 3 },
            name: NAME,
            volumeName: "v",
            engineEnv: {},
            password: "pw",
            clusterKey: KEY,
            memberImages: { [`${NAME}-m3`]: "mongo:8" }
        })!;
        expect(members.map((member) => member.image)).toEqual([undefined, undefined, "mongo:8"]);
    });

    it("gives a MySQL replica root's password alone, so it takes the database and account from the primary", () => {
        const members = topologyMemberPlans({
            topology: { kind: "replicas", replicas: 2 },
            name: NAME,
            volumeName: "mysql-data",
            engineEnv: { MYSQL_ROOT_PASSWORD: "pw", MYSQL_DATABASE: "orders", MYSQL_USER: "polaris", MYSQL_PASSWORD: "pw" },
            password: "pw",
            exposePort: 3307
        })!;
        expect(members[0]!.env.MYSQL_DATABASE).toBe("orders");
        expect(members[0]!.command).toEqual(["mysqld", "--server-id=1", "--gtid-mode=ON", "--enforce-gtid-consistency=ON"]);
        expect(members[0]!.exposePort).toBe(3307);
        expect(members[1]!.env).toEqual({ MYSQL_ROOT_PASSWORD: "pw" });
        expect(members[2]!.command).toContain("--server-id=3");
        expect(members[2]!.aliases).toEqual([`${NAME}-read`]);
    });

    it("renders each layout as one project with a service and a volume per member", () => {
        for (const [topology, services, volumes] of [
            [{ kind: "replicaSet", members: 5 }, 5, 5],
            [{ kind: "sharded", shards: 3 }, 1 + 3 + 9, 3 + 9],
            [{ kind: "replicas", replicas: 1 }, 2, 2]
        ] as const) {
            const members = topologyMemberPlans({
                topology,
                name: NAME,
                volumeName: "data-1a2b",
                engineEnv: {},
                password: "pw",
                clusterKey: KEY
            });
            const spec = dbComposeSpec(
                {
                    ref: { name: NAME, project: "polaris-db-1a2b" },
                    image: topology.kind === "replicas" ? "mysql:8" : "mongo:7",
                    env: {},
                    volumeName: "data-1a2b",
                    dataPath: "/data/db",
                    members
                },
                "polaris-proxy"
            );
            expect(spec.services).toHaveLength(services);
            expect(spec.volumes).toHaveLength(volumes);
            const yaml = renderComposeYaml(forCompose(spec), "/volumes", "/mounts");
            expect(yaml.match(/container_name:/g)).toHaveLength(services);
            if (topology.kind === "sharded") expect(yaml).toContain("mongos --configdb cfg/");
        }
    });

    it("deploys a single instance as the one container it always was", () => {
        expect(
            topologyMemberPlans({ topology: { kind: "single" }, name: NAME, volumeName: "v", engineEnv: {}, password: "pw" })
        ).toBeUndefined();
    });

    it("refuses a MongoDB layout whose key is missing rather than start members that cannot join", () => {
        expect(() =>
            topologyMemberPlans({
                topology: { kind: "replicaSet", members: 3 },
                name: NAME,
                volumeName: "v",
                engineEnv: {},
                password: "pw"
            })
        ).toThrow("cluster key is missing");
    });
});

describe("joining a replica set", () => {
    it("waits for every member, then initiates once from the first and waits for it to be primary", async () => {
        const server = mongoServer({ usersFrom: [NAME] });
        await ensureTopology(server, { name: NAME, topology: { kind: "replicaSet", members: 3 }, admin: ADMIN }, pace());
        expect(server.calls.map((call) => `${call.container} ${call.kind}`)).toEqual([
            `${NAME}-m2 ping`,
            `${NAME}-m3 ping`,
            `${NAME} sign-in`,
            `${NAME} initiate`,
            `${NAME} role`
        ]);
        const initiate = server.calls.find((call) => call.kind === "initiate")!;
        expect(initiate.argv).toContain("-u");
        expect(initiate.argv.at(-1)).toContain(`"${NAME}-m3:27017"`);
    });

    it("names the member that never started answering", async () => {
        const server = mongoServer({ usersFrom: [NAME] });
        server.runIn.mockImplementation(async (container: string, argv: readonly string[]) =>
            container === `${NAME}-m3` && kindOf(argv) === "ping" ? { code: 1, output: "connect ECONNREFUSED" } : { code: 0, output: "1" }
        );
        await expect(
            ensureTopology(server, { name: NAME, topology: { kind: "replicaSet", members: 3 }, admin: ADMIN }, pace())
        ).rejects.toThrow(`${NAME}-m3 did not start answering in time`);
    });
});

describe("joining a sharded cluster", () => {
    const setup = { name: NAME, topology: { kind: "sharded", shards: 2 } as const, admin: ADMIN };

    it("initiates the config servers and each shard, gives each shard its account, then creates the cluster's and adds the shards", async () => {
        const server = mongoServer();
        await ensureTopology(server, setup, pace());
        const steps = server.calls.filter((call) => call.kind !== "ping" && call.kind !== "role" && call.kind !== "sign-in");
        expect(steps.map((call) => `${call.container} ${call.kind}`)).toEqual([
            `${NAME}-cfg1 initiate`,
            `${NAME}-sh1-1 initiate`,
            `${NAME}-sh1-1 create-root`,
            `${NAME}-sh2-1 initiate`,
            `${NAME}-sh2-1 create-root`,
            `${NAME} create-root`,
            `${NAME} add-shards`
        ]);
        // Through the localhost exception: nothing had an account yet.
        const config = steps[0]!;
        expect(config.argv).not.toContain("-u");
        expect(config.argv.at(-1)).toContain("configsvr: true");
        // Every data member answered before anything was initiated.
        const firstInitiate = server.calls.findIndex((call) => call.kind === "initiate");
        const pings = server.calls.slice(0, firstInitiate).filter((call) => call.kind === "ping");
        expect(pings).toHaveLength(9);
        expect(server.calls.at(-1)!.argv).toContain("-u");
    });

    it("signs in on a run after the first, and creates no account twice", async () => {
        const everyone = core.topologyMembers(setup.topology, NAME).map((member) => member.name);
        const server = mongoServer({ usersFrom: everyone });
        await ensureTopology(server, setup, pace());
        expect(server.calls.some((call) => call.kind === "create-root")).toBe(false);
        expect(server.calls.filter((call) => call.kind === "initiate").every((call) => call.argv.includes("-u"))).toBe(true);
        expect(server.calls.at(-1)!.kind).toBe("add-shards");
    });
});

describe("starting read replicas", () => {
    /** Replicas that report `status` once they have been pointed at the
     *  primary, and nothing before - a new replica has no source at all. */
    function mysqlServer(status: string, following: readonly string[] = []) {
        const calls: { container: string; kind: string }[] = [];
        const pointed = new Set(following);
        const runIn = vi.fn(async (container: string, argv: readonly string[]) => {
            const kind = kindOf(argv);
            calls.push({ container, kind });
            if (kind === "follow") pointed.add(container);
            return { code: 0, output: kind === "replica-status" && pointed.has(container) ? status : "" };
        });
        return { calls, runIn };
    }

    const FOLLOWING = "Replica_IO_Running: Yes\nReplica_SQL_Running: Yes\nSeconds_Behind_Source: 0\n";

    it("creates the replication account on the primary, then points each replica at it", async () => {
        const server = mysqlServer(FOLLOWING);
        await ensureTopology(
            server,
            { name: NAME, topology: { kind: "replicas", replicas: 2 }, admin: ADMIN, replicationPassword: "replSecret-2" },
            pace()
        );
        expect(server.calls.map((call) => `${call.container} ${call.kind}`)).toEqual([
            `${NAME} mysql-ready`,
            `${NAME} replication-user`,
            `${NAME}-replica1 mysql-ready`,
            `${NAME}-replica1 replica-status`,
            `${NAME}-replica1 follow`,
            `${NAME}-replica1 read-only`,
            `${NAME}-replica2 mysql-ready`,
            `${NAME}-replica2 replica-status`,
            `${NAME}-replica2 follow`,
            `${NAME}-replica2 read-only`,
            `${NAME}-replica1 replica-status`,
            `${NAME}-replica2 replica-status`
        ]);
    });

    it("leaves a replica that is already following alone", async () => {
        const server = mysqlServer(FOLLOWING, [`${NAME}-replica1`]);
        await ensureTopology(
            server,
            { name: NAME, topology: { kind: "replicas", replicas: 1 }, admin: ADMIN, replicationPassword: "replSecret-2" },
            pace()
        );
        expect(server.calls.some((call) => call.kind === "follow")).toBe(false);
        expect(server.calls.some((call) => call.kind === "read-only")).toBe(true);
    });

    it("says why a replica is not following instead of reporting a setup that looked finished", async () => {
        const server = mysqlServer(
            "Replica_IO_Running: Connecting\nReplica_SQL_Running: Yes\nLast_IO_Error: Access denied for user 'polaris_replica'\n"
        );
        await expect(
            ensureTopology(
                server,
                { name: NAME, topology: { kind: "replicas", replicas: 1 }, admin: ADMIN, replicationPassword: "replSecret-2" },
                pace()
            )
        ).rejects.toThrow(`${NAME}-replica1 is not following the primary: Access denied for user 'polaris_replica'`);
    });
});

describe("a rolling upgrade", () => {
    it("moves the secondaries first, then steps the primary down and moves it last", async () => {
        const roles = new Map<string, string>([
            ["a", "primary"],
            ["b", "secondary"],
            ["c", "secondary"]
        ]);
        const order: string[] = [];
        const runIn = vi.fn(async (container: string, argv: readonly string[]) => {
            if (argv.at(-1)?.includes("rs.stepDown")) {
                order.push(`step down ${container}`);
                roles.set(container, "secondary");
                roles.set("b", "primary");
                return { code: 0, output: "1" };
            }
            return { code: 0, output: roles.get(container) ?? "other" };
        });
        await rollMembers({ runIn }, ["a", "b", "c"], ADMIN, async (member) => void order.push(`move ${member}`), pace());
        expect(order).toEqual(["move b", "move c", "step down a", "move a"]);
    });

    it("refuses before moving anything when a member is not healthy", async () => {
        const runIn = vi.fn(async (container: string) => ({ code: 0, output: container === "c" ? "other" : "secondary" }));
        const move = vi.fn(async () => undefined);
        await expect(rollMembers({ runIn }, ["a", "b", "c"], ADMIN, move, pace())).rejects.toThrow(
            "Every member has to be a healthy primary or secondary before an upgrade, and c is not."
        );
        expect(move).not.toHaveBeenCalled();
    });
});

describe("connection strings", () => {
    function row(fields: Record<string, unknown>) {
        return {
            id: "db-1",
            slug: "orders",
            engine: "mongo",
            containerName: NAME,
            exposePort: null,
            replicaSet: false,
            topology: "single",
            members: 1,
            shards: 0,
            readReplicas: 0,
            parent: null,
            encryptedCredential: Buffer.from("x"),
            credentialNonce: Buffer.from("n"),
            credentialKeyId: "k",
            ...fields
        };
    }

    beforeEach(() => {
        mocks.decrypt.mockReturnValue({ username: "polaris", password: "p@ss", database: "orders" });
    });

    it("lists every member of a replica set and names the set", async () => {
        mocks.findFirst.mockResolvedValue(row({ topology: "replicaSet", members: 3 }));
        const connection = await databaseConnection("db-1", "owner");
        expect(connection.uri).toBe(
            `mongodb://polaris:p%40ss@${NAME}:27017,${NAME}-m2:27017,${NAME}-m3:27017/orders?authSource=admin&replicaSet=rs0`
        );
        expect(connection.hosts).toEqual([NAME, `${NAME}-m2`, `${NAME}-m3`]);
        expect(connection.replicaSet).toBe("rs0");
    });

    it("points at a sharded cluster's router alone", async () => {
        mocks.findFirst.mockResolvedValue(row({ topology: "sharded", shards: 2 }));
        const connection = await databaseConnection("db-1", "owner");
        expect(connection.uri).toBe(`mongodb://polaris:p%40ss@${NAME}:27017/orders?authSource=admin`);
        expect(connection.replicaSet).toBeNull();
    });

    it("reaches a database hosted on a replica set the way its instance is reached", async () => {
        mocks.findFirst.mockResolvedValue(
            row({ containerName: "", parent: { containerName: NAME, exposePort: null, replicaSet: false, topology: "replicaSet", members: 5 } })
        );
        const connection = await databaseConnection("db-1", "owner");
        expect(connection.hosts).toHaveLength(5);
        expect(connection.uri).toContain("?authSource=orders&replicaSet=rs0");
    });

    it("gives a MySQL primary with replicas a read URI over the name they share", async () => {
        mocks.findFirst.mockResolvedValue(row({ engine: "mysql", topology: "replicas", readReplicas: 2 }));
        const connection = await databaseConnection("db-1", "owner");
        expect(connection.uri).toBe(`mysql://polaris:p%40ss@${NAME}:3306/orders`);
        expect(connection.readUri).toBe(`mysql://polaris:p%40ss@${NAME}-read:3306/orders`);
    });

    it("keeps a single-member replica set's connection string as it was", async () => {
        mocks.findFirst.mockResolvedValue(row({ replicaSet: true }));
        const connection = await databaseConnection("db-1", "owner");
        expect(connection.uri).toBe(`mongodb://polaris:p%40ss@${NAME}:27017/orders?authSource=admin&replicaSet=rs0`);
        expect(connection.readUri).toBeNull();
    });
});
