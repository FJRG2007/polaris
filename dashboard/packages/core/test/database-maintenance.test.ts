/**
 * The commands that look after a running database: restore, readiness, Redis
 * modes and loading, MongoDB's replica set, PostgreSQL's point-in-time
 * recovery, version moves and copies from elsewhere.
 *
 * None of these can be run here - they run inside a database container - so
 * what is pinned is exactly what each one would run: which account, which
 * database, that a password travels as an environment value or a positional
 * argument and never inside a script, and that a value that could break out
 * of its argument is refused before it is built into one.
 */

import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";

const POSTGRES: core.RestoreTarget = {
    engine: "postgres",
    database: "shop",
    username: "shop_app",
    password: "ownSecret-123",
    privileges: "owner",
    adminUser: "polaris",
    adminPassword: "adminSecret-456",
    hosted: false,
    file: "/tmp/polaris-op.dump"
};

describe("strictPipe", () => {
    it("fails on the producer's failure, not only the consumer's", () => {
        const script = core.strictPipe('gunzip -c "$1"', 'psql -d "$2"', "$1.failed");
        expect(script).toContain('( gunzip -c "$1" || echo failed > "$1.failed" ) | psql -d "$2"');
        expect(script).toContain('if [ -e "$1.failed" ]; then rm -f "$1.failed"; exit 1; fi');
        // No pipefail: MariaDB's image runs dash, which does not have it.
        expect(script).not.toContain("pipefail");
    });
});

describe("restoreCommands", () => {
    it("drops and recreates a dedicated PostgreSQL database from another database, owned by its account", () => {
        const steps = core.restoreCommands(POSTGRES);
        expect(steps.map((step) => step.describe)).toEqual([
            "Closing connections to the database",
            "Removing the current contents",
            "Creating the database again",
            "Loading the copy"
        ]);
        expect(steps[1]!.argv).toContain("postgres");
        expect(steps[1]!.argv).toContain('DROP DATABASE IF EXISTS "shop"');
        expect(steps[2]!.argv).toContain('CREATE DATABASE "shop" OWNER "shop_app"');
        // The owner loads, so what it creates is its own.
        expect(steps[3]!.argv).toContain("PGPASSWORD=ownSecret-123");
        expect(steps[3]!.argv.slice(-3)).toEqual(["/tmp/polaris-op.dump", "shop_app", "shop"]);
    });

    it("loads as the instance's account and grants again for a hosted read-only database", () => {
        const steps = core.restoreCommands({ ...POSTGRES, hosted: true, privileges: "readonly" });
        expect(steps[2]!.argv).toContain('CREATE DATABASE "shop"');
        expect(steps[3]!.argv).toContain("PGPASSWORD=adminSecret-456");
        const grant = steps.at(-1)!;
        expect(grant.describe).toBe("Granting readonly to shop_app again");
        expect(grant.argv.join(" ")).toContain(
            'GRANT SELECT ON ALL TABLES IN SCHEMA public TO "shop_app"'
        );
    });

    it("works from template1 when the database being restored is postgres itself", () => {
        const steps = core.restoreCommands({ ...POSTGRES, database: "postgres" });
        expect(steps[1]!.argv).toContain("template1");
    });

    it("never names a password in what a step says about itself", () => {
        for (const engine of ["postgres", "mysql", "mariadb", "mongo"] as const) {
            for (const step of core.restoreCommands({ ...POSTGRES, engine })) {
                expect(step.describe).not.toContain("Secret");
            }
        }
    });

    it("passes MySQL's root password as a positional argument, not inside the script", () => {
        const [drop, load] = core.restoreCommands({ ...POSTGRES, engine: "mysql" });
        expect(drop!.argv.slice(0, 3)).toEqual(["mysql", "-uroot", "-padminSecret-456"]);
        expect(load!.argv[2]).not.toContain("adminSecret");
        expect(load!.argv.at(-1)).toBe("adminSecret-456");
    });

    it("renames a MongoDB dump taken from a database of another name", () => {
        const [load] = core.restoreCommands({
            ...POSTGRES,
            engine: "mongo",
            sourceDatabase: "legacy"
        });
        expect(load!.argv).toContain("--nsInclude=legacy.*");
        expect(load!.argv).toContain("--nsFrom=legacy.*");
        expect(load!.argv).toContain("--nsTo=shop.*");
        expect(load!.argv).toContain("--drop");
    });
});

describe("readinessCommand", () => {
    it("asks each engine its own way, with the password out of the argv where the client allows", () => {
        expect(
            core.readinessCommand({ engine: "postgres", username: "u", password: "p" }).argv
        ).toEqual(["pg_isready", "-U", "u"]);
        expect(
            core.readinessCommand({ engine: "redis", username: "", password: "p" }).argv
        ).toEqual(["env", "REDISCLI_AUTH=p", "redis-cli", "ping"]);
        expect(
            core.readinessCommand({ engine: "seaweedfs", username: "", password: "" }).argv
        ).toContain("http://127.0.0.1:9333/cluster/status");
    });
});

describe("Redis", () => {
    it("keeps an existing instance's command unchanged in default mode", () => {
        expect(core.redisServerCommand("pw", "default")).toEqual([
            "redis-server",
            "--requirepass",
            "pw"
        ]);
    });

    it("turns persistence off and eviction on in cache mode", () => {
        const command = core.redisServerCommand("pw", "cache", 512);
        expect(command).toEqual(
            expect.arrayContaining(["--save", "", "--appendonly", "no", "--maxmemory", "512mb"])
        );
        expect(command).toContain("allkeys-lru");
    });

    it("logs every write in persistent mode", () => {
        expect(core.redisServerCommand("pw", "persistent")).toEqual(
            expect.arrayContaining(["--appendonly", "yes", "--appendfsync", "everysec"])
        );
    });

    it("needs a memory limit for a cache, from the offered sizes", () => {
        const id = "00000000-0000-4000-8000-000000000000";
        expect(core.redisModeSchema.safeParse({ databaseId: id, mode: "cache" }).success).toBe(
            false
        );
        expect(
            core.redisModeSchema.safeParse({ databaseId: id, mode: "cache", maxMemoryMb: 300 })
                .success
        ).toBe(false);
        expect(
            core.redisModeSchema.safeParse({ databaseId: id, mode: "cache", maxMemoryMb: 256 })
                .success
        ).toBe(true);
        expect(core.redisModeSchema.safeParse({ databaseId: id, mode: "persistent" }).success).toBe(
            true
        );
    });

    it("reads a replica's synchronisation as finished only once the link is up and nothing is loading", () => {
        expect(
            core.redisSyncDone(
                "role:slave\r\nmaster_link_status:up\r\nmaster_sync_in_progress:0\r\n"
            )
        ).toBe(true);
        expect(
            core.redisSyncDone(
                "role:slave\r\nmaster_link_status:up\r\nmaster_sync_in_progress:1\r\n"
            )
        ).toBe(false);
        expect(
            core.redisSyncDone(
                "role:slave\r\nmaster_link_status:down\r\nmaster_sync_in_progress:0\r\n"
            )
        ).toBe(false);
        expect(core.redisSyncDone("role:master\r\n")).toBe(false);
    });
});

describe("MongoDB replica set", () => {
    it("creates the key file before handing over to the image's entrypoint", () => {
        const [, , script] = core.mongoReplicaSetCommand();
        expect(script).toContain("chmod 400");
        expect(script).toContain(
            "exec docker-entrypoint.sh mongod --replSet rs0 --bind_ip_all --keyFile"
        );
    });

    it("initiates once, tolerating a set somebody else initiated first", () => {
        const command = core.mongoInitiateCommand("root", "pw", "polaris-db-abc");
        expect(command.argv.at(-1)).toContain('"polaris-db-abc:27017"');
        expect(command.argv.at(-1)).toContain("AlreadyInitialized");
    });

    it("refuses a member host that is not a container name", () => {
        expect(() =>
            core.mongoInitiateCommand("root", "pw", 'x" }); db.dropDatabase(); ({"')
        ).toThrow();
    });
});

describe("point-in-time recovery", () => {
    it("archives with the command the manual gives, into the mounted archive", () => {
        const command = core.pitrServerCommand();
        expect(command).toContain("archive_mode=on");
        expect(command).toContain(
            "archive_command=test ! -f /polaris-pitr/wal/%f && cp %p /polaris-pitr/wal/%f"
        );
    });

    it("labels a base backup with a timestamp safe in a path", () => {
        expect(core.pitrLabel(new Date("2026-09-10T12:34:56.789Z"))).toBe("2026-09-10T12-34-56Z");
        expect(() => core.pitrBaseBackupCommand("../../etc", "polaris")).toThrow();
        expect(core.pitrBaseBackupCommand("2026-09-10T12-34-56Z", "polaris").argv).toContain(
            "/polaris-pitr/base/2026-09-10T12-34-56Z"
        );
    });

    it("starts from the newest base backup that had finished by the target", () => {
        const bases = [
            { label: "a", finishedAt: new Date("2026-09-01T00:10:00Z") },
            { label: "b", finishedAt: new Date("2026-09-02T00:10:00Z") },
            { label: "c", finishedAt: new Date("2026-09-03T00:10:00Z") }
        ];
        expect(core.pitrBaseFor(bases, new Date("2026-09-02T12:00:00Z"))?.label).toBe("b");
        // One still running at the target is no use; the one before it is.
        expect(core.pitrBaseFor(bases, new Date("2026-09-03T00:05:00Z"))?.label).toBe("b");
        expect(core.pitrBaseFor(bases, new Date("2026-08-31T00:00:00Z"))).toBeNull();
    });

    it("cleans up by a backup history file name and nothing else", () => {
        expect(() => core.pitrCleanupCommands("; rm -rf /", [])).toThrow();
        const commands = core.pitrCleanupCommands("000000010000000000000003.00000028.backup", [
            "2026-09-01T00-00-00Z"
        ]);
        expect(commands.map((command) => command.argv[0])).toEqual(["rm", "pg_archivecleanup"]);
        expect(commands[1]!.argv).toEqual([
            "pg_archivecleanup",
            "/polaris-pitr/wal",
            "000000010000000000000003.00000028.backup"
        ]);
    });

    it("recovers to the target as a positional argument, in the form PostgreSQL reads", () => {
        const target = new Date("2026-09-10T08:15:30.000Z");
        expect(core.toRecoveryTime(target)).toBe("2026-09-10 08:15:30+00");
        const command = core.pitrRecoveryCommand("2026-09-10T00-00-00Z", target);
        expect(command.slice(3)).toEqual([
            "polaris",
            "/polaris-pitr/base/2026-09-10T00-00-00Z/base.tar.gz",
            "2026-09-10 08:15:30+00",
            "/polaris-pitr"
        ]);
        expect(command[2]).toContain("recovery.signal");
        expect(command[2]).toContain("recovery_target_action = 'promote'");
    });

    it("offers only the listed windows", () => {
        const id = "00000000-0000-4000-8000-000000000000";
        expect(
            core.pitrSettingsSchema.safeParse({ databaseId: id, enabled: true, keepDays: 7 })
                .success
        ).toBe(true);
        expect(
            core.pitrSettingsSchema.safeParse({ databaseId: id, enabled: true, keepDays: 5 })
                .success
        ).toBe(false);
    });
});

describe("versions", () => {
    it("compares numerically, not as text", () => {
        expect(core.compareVersions("10.11", "9")).toBeGreaterThan(0);
        expect(core.compareVersions("8", "8.4")).toBeLessThan(0);
    });

    it("offers only newer versions to move to", () => {
        expect(core.upgradeTargets("postgres", "16")).toEqual(["18", "17"]);
        expect(core.upgradeTargets("postgres", "18")).toEqual([]);
    });

    it("treats only the same tag as an in-place update", () => {
        expect(core.isInPlaceUpgrade("16", "16")).toBe(true);
        expect(core.isInPlaceUpgrade("16", "17")).toBe(false);
    });

    it("keeps PostgreSQL 18's data where its image writes it", () => {
        expect(core.databaseDataPath("postgres", "17")).toBe("/var/lib/postgresql/data");
        expect(core.databaseDataPath("postgres", "18")).toBe("/var/lib/postgresql");
    });

    it("finds databases Polaris did not make, ignoring the engine's own and a client's warnings", () => {
        const listed = [
            "mysql: [Warning] Using a password on the command line interface can be insecure.",
            "information_schema",
            "mysql",
            "shop",
            "legacy"
        ].join("\n");
        expect(core.unknownNames("mysql", listed, ["shop"])).toEqual(["legacy"]);
        expect(core.listDatabasesCommand("postgres", "polaris", "pw").argv).toContain(
            "PGPASSWORD=pw"
        );
    });
});

describe("copying from elsewhere", () => {
    it("reads a PostgreSQL URL into its parts", () => {
        expect(
            core.parseExternalSource(
                "postgresql://app:p%40ss@db.example.com:6543/shop?sslmode=require",
                "postgres"
            )
        ).toEqual({
            engine: "postgres",
            host: "db.example.com",
            port: 6543,
            database: "shop",
            username: "app",
            password: "p@ss",
            tls: true,
            authSource: "admin"
        });
    });

    it("reads mysql:// as MariaDB when the destination is MariaDB", () => {
        expect(core.parseExternalSource("mysql://u:p@h/db", "mariadb")?.engine).toBe("mariadb");
    });

    it("keeps MongoDB's authSource and ignores Redis' numbered database", () => {
        expect(
            core.parseExternalSource("mongodb://u:p@h/app?authSource=app", "mongo")?.authSource
        ).toBe("app");
        expect(core.parseExternalSource("redis://:p@h:6380/2", "redis")).toMatchObject({
            database: "",
            port: 6380
        });
    });

    it("refuses what cannot be passed safely to a dump tool", () => {
        expect(core.parseExternalSource("not a url", "postgres")).toBeNull();
        expect(core.parseExternalSource("ftp://h/db", "postgres")).toBeNull();
        expect(core.parseExternalSource("postgresql://u:p@h/db;drop", "postgres")).toBeNull();
        expect(core.parseExternalSource("mongodb+srv://u:p@cluster/db", "mongo")).toBeNull();
    });

    it("keeps the source's password out of the script text", () => {
        const postgres = core.externalDumpCommand(
            core.parseExternalSource("postgresql://u:hunter22@h/db", "postgres")!,
            "/tmp/x"
        );
        expect(postgres.argv).toContain("PGPASSWORD=hunter22");
        expect(postgres.argv.find((part) => part.includes("pg_dump"))).not.toContain("hunter22");
        const mysql = core.externalDumpCommand(
            core.parseExternalSource("mysql://u:hunter22@h/db", "mysql")!,
            "/tmp/x"
        );
        expect(mysql.argv[2]).not.toContain("hunter22");
        expect(mysql.argv.at(-1)).toBe("hunter22");
        expect(mysql.describe).not.toContain("hunter22");
    });
});
