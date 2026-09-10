/**
 * Databases laid out over several containers: what a create request may ask
 * for, which containers each layout is, the command each one starts with, and
 * the steps that join them - read exactly as they would run, since none of
 * them can run here.
 */

import * as core from "../src/index.js";
import { describe, expect, it } from "vitest";

const ENVIRONMENT = "00000000-0000-4000-8000-000000000001";
const NAME = "shop-orders-1a2b";

function create(input: Partial<core.DatabaseCreateInput>) {
    return core.databaseCreateSchema.safeParse({
        environmentId: ENVIRONMENT,
        name: "orders",
        engine: "mongo",
        ...input
    });
}

function messages(input: Partial<core.DatabaseCreateInput>): string[] {
    const parsed = create(input);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

/** Every argument a container would be started with, checked for a line break
 *  or any other control character the host daemon refuses. */
function hasControl(args: readonly string[]): boolean {
    return args.some((arg) => /[\x00-\x1f\x7f]/.test(arg));
}

describe("the create schema's layouts", () => {
    it("defaults to a single instance", () => {
        const parsed = create({});
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.topology).toBe("single");
        expect(core.topologyOf({})).toEqual({ kind: "single" });
    });

    it("fills in the sizes a layout left off", () => {
        expect(core.topologyOf({ topology: "replicaSet" })).toEqual({
            kind: "replicaSet",
            members: 3
        });
        expect(core.topologyOf({ topology: "sharded" })).toEqual({ kind: "sharded", shards: 2 });
        expect(core.topologyOf({ topology: "replicas" })).toEqual({
            kind: "replicas",
            replicas: 1
        });
    });

    it("accepts each layout on the engine it is for", () => {
        expect(create({ topology: "replicaSet", members: 5 }).success).toBe(true);
        expect(create({ topology: "sharded", shards: 4, exposePort: 27018 }).success).toBe(true);
        expect(create({ engine: "mysql", topology: "replicas", readReplicas: 2 }).success).toBe(
            true
        );
    });

    it("refuses a layout on an engine it is not for", () => {
        expect(messages({ engine: "postgres", topology: "replicaSet" })[0]).toContain(
            "MongoDB only"
        );
        expect(messages({ engine: "mongo", topology: "replicas" })[0]).toContain("MySQL only");
        expect(messages({ engine: "mariadb", topology: "replicas" })[0]).toContain("MySQL only");
    });

    it("refuses sizes that are not offered, and sizes for another layout", () => {
        expect(messages({ topology: "replicaSet", members: 4 })).toContain(
            "A replica set has 3 or 5 members"
        );
        expect(messages({ topology: "sharded", shards: 1 })).toContain(
            "A sharded cluster starts with 2, 3 or 4 shards"
        );
        expect(messages({ engine: "mysql", topology: "replicas", readReplicas: 3 })).toContain(
            "Add 1 or 2 read replicas"
        );
        expect(messages({ topology: "single", members: 3 })).toContain(
            "Only a replica set has members to count"
        );
        expect(messages({ topology: "replicaSet", shards: 2 })).toContain(
            "Only a sharded cluster has shards"
        );
    });

    it("refuses a layout for a database placed on an existing instance", () => {
        expect(
            messages({ topology: "replicaSet", instanceId: "00000000-0000-4000-8000-000000000002" })
        ).toContain("A database on an existing instance runs the way that instance does");
    });

    it("never publishes a replica set, whose members only the environment can name", () => {
        expect(messages({ topology: "replicaSet", exposePort: 27018 })[0]).toContain(
            "not published"
        );
    });

    it("reads a stored layout back, and treats anything unknown as one container", () => {
        const stored = core.topologyColumns({ kind: "sharded", shards: 3 });
        expect(stored).toEqual({ topology: "sharded", members: 1, shards: 3, readReplicas: 0 });
        expect(core.resolveTopology(stored)).toEqual({ kind: "sharded", shards: 3 });
        expect(core.resolveTopology({ topology: "galaxy" })).toEqual({ kind: "single" });
        expect(core.resolveTopology({ topology: "replicaSet", members: 7 })).toEqual({
            kind: "replicaSet",
            members: 3
        });
        expect(core.topologyRequest({ kind: "replicas", replicas: 2 })).toEqual({
            topology: "replicas",
            readReplicas: 2
        });
    });
});

describe("the containers of a layout", () => {
    it("keeps the instance's own name for the member everything reaches", () => {
        const set = core.topologyMembers({ kind: "replicaSet", members: 3 }, NAME);
        expect(set.map((member) => member.name)).toEqual([NAME, `${NAME}-m2`, `${NAME}-m3`]);
        expect(set.map((member) => member.volumeSuffix)).toEqual(["", "-m2", "-m3"]);
    });

    it("lays a sharded cluster out as a router, three config servers and three members per shard", () => {
        const members = core.topologyMembers({ kind: "sharded", shards: 2 }, NAME);
        expect(members).toHaveLength(1 + 3 + 6);
        expect(members[0]).toEqual({ name: NAME, role: "router", set: null, volumeSuffix: null });
        expect(
            members.filter((member) => member.role === "config").map((member) => member.set)
        ).toEqual(["cfg", "cfg", "cfg"]);
        expect(
            members.filter((member) => member.set === "shard2").map((member) => member.name)
        ).toEqual([`${NAME}-sh2-1`, `${NAME}-sh2-2`, `${NAME}-sh2-3`]);
    });

    it("names a MySQL primary's replicas, and the name they share for reads", () => {
        const members = core.topologyMembers({ kind: "replicas", replicas: 2 }, NAME);
        expect(members.map((member) => [member.name, member.role])).toEqual([
            [NAME, "primary"],
            [`${NAME}-replica1`, "replica"],
            [`${NAME}-replica2`, "replica"]
        ]);
        expect(core.topologyAddress({ kind: "replicas", replicas: 2 }, NAME).readHost).toBe(
            `${NAME}-read`
        );
    });

    it("cuts a long name in the middle, keeping the hash that tells instances apart", () => {
        const long = `${"a".repeat(55)}-9f3c`;
        const name = core.memberName(long, "-sh4-3");
        expect(name.length).toBeLessThanOrEqual(63);
        expect(name.endsWith("-9f3c-sh4-3")).toBe(true);
    });

    it("lists every member of a replica set for a client, and only the router for a cluster", () => {
        expect(core.topologyAddress({ kind: "replicaSet", members: 3 }, NAME)).toEqual({
            hosts: [NAME, `${NAME}-m2`, `${NAME}-m3`],
            replicaSet: "rs0",
            readHost: null
        });
        expect(core.topologyAddress({ kind: "sharded", shards: 2 }, NAME)).toEqual({
            hosts: [NAME],
            replicaSet: null,
            readHost: null
        });
    });
});

describe("starting MongoDB members", () => {
    const sharded: core.DbTopology = { kind: "sharded", shards: 2 };
    const members = core.topologyMembers(sharded, NAME);

    it("writes the key from the environment to a private file and hands over to the entrypoint", () => {
        const [member] = core.topologyMembers({ kind: "replicaSet", members: 3 }, NAME);
        const command = core.mongoMemberCommand(member!, { kind: "replicaSet", members: 3 }, NAME);
        expect(command.slice(0, 2)).toEqual(["sh", "-c"]);
        const script = command[2]!;
        expect(script).toContain("printf '%s' \"$POLARIS_MONGO_KEY\" > /etc/polaris-mongo.key");
        expect(script).toContain("chmod 400 /etc/polaris-mongo.key");
        expect(script).toContain("unset POLARIS_MONGO_KEY");
        expect(script).toContain(
            "exec docker-entrypoint.sh mongod --replSet rs0 --bind_ip_all --keyFile /etc/polaris-mongo.key"
        );
        expect(hasControl(command)).toBe(false);
    });

    it("starts config servers and shard members on the one port, with their roles", () => {
        const config = members.find((member) => member.role === "config")!;
        const shard = members.find((member) => member.role === "shard")!;
        expect(core.mongoMemberCommand(config, sharded, NAME)[2]).toContain(
            "mongod --configsvr --replSet cfg --port 27017 --dbpath /data/db --bind_ip_all --keyFile"
        );
        expect(core.mongoMemberCommand(shard, sharded, NAME)[2]).toContain(
            "mongod --shardsvr --replSet shard1 --port 27017 --bind_ip_all"
        );
    });

    it("points the router at the config server replica set by its seed list", () => {
        const router = core.mongoMemberCommand(members[0]!, sharded, NAME)[2]!;
        expect(router).toContain(
            `mongos --configdb cfg/${NAME}-cfg1:27017,${NAME}-cfg2:27017,${NAME}-cfg3:27017 --port 27017 --bind_ip_all --keyFile`
        );
        expect(
            hasControl(members.flatMap((member) => core.mongoMemberCommand(member, sharded, NAME)))
        ).toBe(false);
    });

    it("accepts only a key the manual would", () => {
        expect(core.isClusterKey("ab".repeat(384))).toBe(true);
        expect(core.isClusterKey("short")).toBe(false);
        expect(core.isClusterKey(`${"ab".repeat(100)}\n`)).toBe(false);
    });
});

describe("joining MongoDB members", () => {
    const admin = { username: "polaris", password: "adminSecret-456" };

    it("initiates a set with every member, the first preferred as primary", () => {
        const [set] = core.mongoSets({ kind: "replicaSet", members: 3 }, NAME);
        const script = core.mongoSetInitiateCommand(admin, set!).argv.at(-1)!;
        expect(script).toContain(`{ _id: 0, host: "${NAME}:27017", priority: 2 }`);
        expect(script).toContain(`{ _id: 2, host: "${NAME}-m3:27017", priority: 1 }`);
        expect(script).toContain("AlreadyInitialized");
        expect(script).not.toContain("configsvr");
    });

    it("initiates the config servers as a config server replica set, through the localhost exception", () => {
        const [config] = core.mongoSets({ kind: "sharded", shards: 2 }, NAME);
        const command = core.mongoSetInitiateCommand(null, config!);
        expect(command.argv).not.toContain("-u");
        expect(command.argv.at(-1)).toContain('{ _id: "cfg", configsvr: true, members: [');
    });

    it("refuses a member that is not a container name", () => {
        expect(() =>
            core.mongoSetInitiateCommand(admin, {
                name: "rs0",
                hosts: ['x" }); db.dropDatabase(); ({"']
            })
        ).toThrow();
    });

    it("adds only the shards the router does not list yet, by their seed lists", () => {
        const shards = core
            .mongoSets({ kind: "sharded", shards: 2 }, NAME)
            .filter((set) => !set.configsvr);
        const script = core.mongoAddShardsCommand(admin, shards).argv.at(-1)!;
        expect(script).toContain("listShards: 1");
        expect(script).toContain(
            `"shard1/${NAME}-sh1-1:27017,${NAME}-sh1-2:27017,${NAME}-sh1-3:27017"`
        );
        expect(script).toContain("sh.addShard(seed)");
    });

    it("creates the first account through the localhost exception, signed in as nobody", () => {
        const command = core.mongoCreateRootCommand(admin, "the cluster");
        expect(command.argv).not.toContain("-u");
        expect(command.argv.at(-1)).toContain('roles: [{ role: "root", db: "admin" }]');
    });

    it("reads a member's role and a set's status, and nothing else", () => {
        expect(core.mongoRoleOf("Current Mongosh Log ID: x\nsecondary\n")).toBe("secondary");
        expect(core.mongoRoleOf("MongoNetworkError")).toBe("other");
        expect(core.parseSetStatus('[{"name":"a:27017","state":"PRIMARY","health":1}]')).toEqual([
            { name: "a", state: "PRIMARY", healthy: true }
        ]);
        expect(core.parseSetStatus("MongoServerError: not authorized")).toBeNull();
        expect(core.parseSetStatus('[{"name":1}]')).toBeNull();
    });
});

describe("upgrading a replica set", () => {
    it("moves one major version at a time", () => {
        expect(core.rollingPath(["8", "7", "6"], "6", "8")).toEqual(["7", "8"]);
        expect(core.rollingPath(["8", "7", "6"], "7", "8")).toEqual(["8"]);
    });

    it("confirms a feature compatibility version from 7.0, as the command requires", () => {
        const admin = { username: "polaris", password: "pw-secret-123" };
        expect(core.mongoSetFcvCommand(admin, "8").argv.at(-1)).toContain(
            'setFeatureCompatibilityVersion: "8.0", confirm: true'
        );
        expect(core.mongoSetFcvCommand(admin, "6").argv.at(-1)).toContain(
            'setFeatureCompatibilityVersion: "6.0" }'
        );
        expect(core.fcvOf("7")).toBe("7.0");
    });
});

describe("MySQL read replicas", () => {
    it("starts every server with an id of its own and GTIDs on", () => {
        expect(core.mysqlMemberCommand(1)).toEqual([
            "mysqld",
            "--server-id=1",
            "--gtid-mode=ON",
            "--enforce-gtid-consistency=ON"
        ]);
        expect(() => core.mysqlMemberCommand(0)).toThrow();
    });

    it("creates the replication account with the one privilege it needs", () => {
        const sql = core.mysqlReplicationUserCommand("rootSecret-1", "replSecret-2").argv.at(-1)!;
        expect(sql).toContain(
            "CREATE USER IF NOT EXISTS 'polaris_replica'@'%' IDENTIFIED BY 'replSecret-2'"
        );
        expect(sql).toContain("GRANT REPLICATION SLAVE ON *.* TO 'polaris_replica'@'%'");
    });

    it("points a replica at its primary by GTID auto-positioning, then makes it read-only", () => {
        const [follow, readOnly] = core.mysqlFollowCommands("rootSecret-1", NAME, "replSecret-2");
        const sql = follow!.argv.at(-1)!;
        expect(sql.startsWith("STOP REPLICA;")).toBe(true);
        expect(sql).toContain(
            `CHANGE REPLICATION SOURCE TO SOURCE_HOST = '${NAME}', SOURCE_PORT = 3306,`
        );
        expect(sql).toContain(
            "SOURCE_AUTO_POSITION = 1, SOURCE_SSL = 1, GET_SOURCE_PUBLIC_KEY = 1;"
        );
        expect(sql.endsWith("START REPLICA;")).toBe(true);
        expect(readOnly!.argv.at(-1)).toBe("SET PERSIST super_read_only = ON;");
    });

    it("refuses a value that would break out of a statement", () => {
        expect(() => core.mysqlFollowCommands("root", NAME, "x'; DROP USER root; --")).toThrow();
        expect(() => core.mysqlFollowCommands("root", "bad host", "replSecret-2")).toThrow();
    });

    it("reads whether a replica follows, how far behind, and why not", () => {
        const healthy = core.parseReplicaStatus(
            "*** 1. row ***\n  Replica_IO_Running: Yes\n Replica_SQL_Running: Yes\n Seconds_Behind_Source: 0\n Last_IO_Error: \n Last_SQL_Error: \n"
        );
        expect(healthy).toEqual({ following: true, lagSeconds: 0, error: null });
        const broken = core.parseReplicaStatus(
            "Replica_IO_Running: Connecting\nReplica_SQL_Running: Yes\nSeconds_Behind_Source: NULL\nLast_IO_Error: error connecting to source\n"
        );
        expect(broken).toEqual({
            following: false,
            lagSeconds: null,
            error: "error connecting to source"
        });
    });

    it("offers a read URI as a reference of its own", () => {
        const keys = core.databaseReferenceKeys({
            engine: "mysql",
            host: NAME,
            port: 3306,
            database: "orders",
            username: "polaris",
            password: "pw",
            uri: `mysql://polaris:pw@${NAME}:3306/orders`,
            readUri: `mysql://polaris:pw@${NAME}-read:3306/orders`
        });
        expect(keys.READ_URL).toBe(`mysql://polaris:pw@${NAME}-read:3306/orders`);
        expect(keys.MYSQL_READ_URL).toBe(keys.READ_URL);
    });
});

describe("container commands", () => {
    it("are one line, which both the host daemon and a remote compose file take", () => {
        expect(hasControl(core.mongoReplicaSetCommand())).toBe(false);
        expect(
            hasControl(
                core.pitrRecoveryCommand("2026-09-10T00-00-00Z", new Date("2026-09-10T08:15:30Z"))
            )
        ).toBe(false);
    });
});
