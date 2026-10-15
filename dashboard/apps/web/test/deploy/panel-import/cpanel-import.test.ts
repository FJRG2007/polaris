/**
 * Importing a cPanel backup: one project, one MySQL instance with every dump
 * loaded (the rest inside it), a service per site folder with its domains, and
 * the scratch folder gone afterwards - also when the import fails. The backup
 * reader, Deploy and the database operations are fakes; the scratch folder is
 * real so the dump and the site folders are read from disk.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CpanelPlan } from "@/lib/deploy/panel-import/cpanel";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "00000000-0000-7000-8000-0000000000aa";

let scratch = "";
let plan: CpanelPlan;
const events: string[] = [];

const createProject = vi.fn(async (_owner: string, name: string, _org: string | null, _mode?: string) => {
    events.push(`project ${name}`);
    return { id: "project-1", environments: [{ id: "env-1" }] };
});
const createApplication = vi.fn(async (_owner: string, input: { name: string }) => {
    events.push(`service ${input.name}`);
    return { id: `app-${input.name}` };
});
const addApplicationDomain = vi.fn(async (id: string, _owner: string, opts: { hostname: string }) => {
    if (opts.hostname === "taken.test") throw new Error("taken");
    events.push(`domain ${opts.hostname} -> ${id}`);
    return opts.hostname;
});
const deployApplication = vi.fn(async (id: string) => {
    events.push(`deploy ${id}`);
    return "deployment";
});
const createDatabase = vi.fn(async (_owner: string, input: { name: string; instanceId?: string }) => {
    events.push(`database ${input.name}${input.instanceId ? ` in ${input.instanceId}` : ""}`);
    return { id: `db-${input.name}` };
});
const deployDatabaseAndWait = vi.fn(async (_id: string, _owner: string, _actor: string): Promise<string | null> => null);
const restoreDumpInto = vi.fn(async (context: { id: string }, file: { local: string }) => {
    expect((await stat(file.local)).size).toBeGreaterThan(0);
    events.push(`load ${context.id}`);
});
const storeSourceFolder = vi.fn(async (id: string, _owner: string, dir: string, _name: string, counted: { files: number }) => {
    events.push(`source ${id} ${dir.slice(scratch.length).replace(/\\/g, "/")} ${counted.files}`);
    return {};
});

const deleteProject = vi.fn(async (id: string) => void events.push(`delete project ${id}`));
const deleteApplication = vi.fn(async (id: string) => void events.push(`delete service ${id}`));
const deleteDatabase = vi.fn(async (id: string) => void events.push(`delete database ${id}`));
/** What the project holds when a rollback looks. */
let present: { environments: number; applications: string[]; databases: string[] } | null = null;

vi.mock("@/lib/deploy-service", () => ({
    createProject,
    createApplication,
    addApplicationDomain,
    deployApplication,
    deleteProject,
    deleteApplication
}));
const databaseConnection = vi.fn(async (id: string) => ({
    host: `mysql-${id}`,
    port: 3306,
    database: id.replace("db-", "") + "_new",
    username: "polaris_user",
    password: "pa'ss",
    uri: `mysql://polaris_user:x@mysql-${id}:3306/db`
}));
const setEnvVars = vi.fn(async (_scope: string, _id: string, _owner: string, vars: Array<{ key: string }>) => vars.length);

vi.mock("@/lib/database-service", () => ({ createDatabase, deployDatabaseAndWait, deleteDatabase, databaseConnection }));
vi.mock("@/lib/env-var-service", () => ({ setEnvVars }));
vi.mock("@polaris/db", () => ({
    prisma: {
        environment: { count: async () => present?.environments ?? 1 },
        application: { findMany: async () => (present?.applications ?? []).map((id) => ({ id })) },
        managedDatabase: { findMany: async () => (present?.databases ?? []).map((id) => ({ id })) }
    }
}));
vi.mock("@/lib/deploy/source-upload", () => ({ storeSourceFolder }));
vi.mock("@/lib/deploy-target-service", () => ({ getOrCreateLocalTarget: async () => ({ id: "target-1" }) }));
vi.mock("@/lib/deploy/service-networks", () => ({ NEW_ENVIRONMENT_NETWORK_MODE: "environment" }));
vi.mock("@/lib/database-ops/restore", () => ({ restoreDumpInto }));
vi.mock("@/lib/database-ops/ops", () => ({
    instanceContext: async (id: string) => ({ id }),
    startOperation: async () => ({ succeed: async () => undefined, fail: async () => "failed" })
}));
vi.mock("@/lib/deploy/panel-import/cpanel", () => ({
    inspectCpanelBackup: async () => ({ dir: scratch, root: join(scratch, "backup"), plan })
}));

const { importCpanelBackup, pickDatabase, rollbackScope } = await import("@/lib/deploy/panel-import/import");

const input = (orgId: string | null = null) => ({ archive: "backup.tar.gz", ownerId: OWNER, orgId, actorId: OWNER });

beforeEach(async () => {
    events.length = 0;
    present = null;
    vi.clearAllMocks();
    scratch = await mkdtemp(join(tmpdir(), "polaris-test-import-"));
    const root = join(scratch, "backup");
    await mkdir(join(root, "mysql"), { recursive: true });
    await mkdir(join(root, "homedir", "public_html", "wp"), { recursive: true });
    await mkdir(join(root, "homedir", "addon.test"), { recursive: true });
    await writeFile(join(root, "mysql", "acct_wp.sql"), "CREATE TABLE t (id int);\n");
    await writeFile(join(root, "mysql", "acct_shop.sql"), "CREATE TABLE s (id int);\n");
    await writeFile(join(root, "homedir", "public_html", "index.php"), "<?php echo 1;");
    await writeFile(join(root, "homedir", "public_html", "wp", "a.php"), "<?php");
    await writeFile(join(root, "homedir", "addon.test", "index.html"), "addon");
    plan = {
        account: "acct",
        hasHome: true,
        warnings: [],
        domains: [
            { name: "main.test", primary: true, documentRoot: "public_html" },
            { name: "www-alias.test", primary: false, documentRoot: "public_html" },
            { name: "addon.test", primary: false, documentRoot: "addon.test" },
            { name: "taken.test", primary: false, documentRoot: "addon.test" },
            { name: "gone.test", primary: false, documentRoot: "missing" }
        ],
        databases: [
            { name: "acct_shop", dump: "mysql/acct_shop.sql", bytes: 10 },
            { name: "acct_wp", dump: "mysql/acct_wp.sql", bytes: 10 }
        ]
    };
});

afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
});

describe("importCpanelBackup", () => {
    it("makes the project, databases, services and domains in order", async () => {
        const result = await importCpanelBackup(input());
        expect(events).toEqual([
            "project main.test",
            "database acct_shop",
            "load db-acct_shop",
            "database acct_wp in db-acct_shop",
            "load db-acct_wp",
            "service main.test",
            "source app-main.test /backup/homedir/public_html 2",
            "domain main.test -> app-main.test",
            "domain www-alias.test -> app-main.test",
            "deploy app-main.test",
            "service addon.test",
            "source app-addon.test /backup/homedir/addon.test 1",
            "domain addon.test -> app-addon.test",
            "deploy app-addon.test"
        ]);
        expect(result).toMatchObject({ projectId: "project-1", services: 2, databases: 2 });
        expect(result.domains).toEqual(["main.test", "www-alias.test", "addon.test"]);
        // taken.test, and the folder gone.test serves.
        expect(result.warnings).toEqual([
            { code: "domainTaken", name: "taken.test" },
            { code: "folderMissing", name: "gone.test" }
        ]);
        expect(createDatabase.mock.calls[0]?.[1]).toMatchObject({ engine: "mysql", databaseName: "acct_shop", environmentId: "env-1" });
        await expect(stat(scratch)).rejects.toThrow();
    });

    it("reports a database that will not deploy and carries on", async () => {
        deployDatabaseAndWait.mockResolvedValueOnce("no room");
        const result = await importCpanelBackup(input());
        expect(result.databases).toBe(1);
        expect(events).toContain("database acct_wp");
        expect(result.warnings).toContainEqual({ code: "databaseFailed", name: "acct_shop" });
    });

    it("picks another project name when the first is taken", async () => {
        createProject.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
        await importCpanelBackup(input("org-1"));
        expect(createProject.mock.calls.map((call) => call[1])).toEqual(["main.test", "main.test 2"]);
        expect(createProject.mock.calls[1]?.[2]).toBe("org-1");
    });

    it("removes the scratch folder when the import fails", async () => {
        createProject.mockRejectedValueOnce(new Error("database down"));
        await expect(importCpanelBackup(input())).rejects.toThrow("database down");
        await expect(stat(scratch)).rejects.toThrow();
        expect(createApplication).not.toHaveBeenCalled();
    });

    it("takes the whole project back when a site cannot be made", async () => {
        storeSourceFolder.mockRejectedValueOnce(new Error("disk full"));
        present = { environments: 1, applications: ["app-main.test"], databases: ["db-acct_shop", "db-acct_wp"] };
        await expect(importCpanelBackup(input())).rejects.toThrow("disk full");
        expect(events.at(-1)).toBe("delete project project-1");
        expect(deleteApplication).not.toHaveBeenCalled();
        await expect(stat(scratch)).rejects.toThrow();
    });

    it("keeps a project somebody added to, removing only what the import made", async () => {
        storeSourceFolder.mockRejectedValueOnce(new Error("disk full"));
        present = { environments: 1, applications: ["app-main.test", "app-theirs"], databases: ["db-acct_shop", "db-acct_wp"] };
        await expect(importCpanelBackup(input())).rejects.toThrow("disk full");
        expect(deleteProject).not.toHaveBeenCalled();
        expect(events.slice(-3)).toEqual(["delete service app-main.test", "delete database db-acct_wp", "delete database db-acct_shop"]);
    });

    it("has nothing to take back when the project was never made", async () => {
        createProject.mockRejectedValueOnce(new Error("database down"));
        await expect(importCpanelBackup(input())).rejects.toThrow("database down");
        expect(deleteProject).not.toHaveBeenCalled();
    });
});

describe("rollbackScope", () => {
    const made = { projectId: "p", applications: ["a"], databases: ["d"] };
    it("takes the project when it holds only what the import made", () => {
        expect(rollbackScope(made, { environments: 1, applications: ["a"], databases: [] })).toBe("project");
    });
    it("keeps it when anything else is in it", () => {
        expect(rollbackScope(made, { environments: 1, applications: ["a"], databases: ["d", "x"] })).toBe("own");
        expect(rollbackScope(made, { environments: 2, applications: ["a"], databases: ["d"] })).toBe("own");
    });
});

describe("pointing a site at its database", () => {
    const WP = [
        "<?php",
        "// define( 'DB_NAME', 'commented' );",
        "define( 'DB_NAME', 'acct_wp' );",
        "define( 'DB_USER', 'acct_u' );",
        "define( 'DB_PASSWORD', 'old' );",
        "define( 'DB_HOST', 'localhost' );",
        "$table_prefix = 'wp_';",
        ""
    ].join("\n");

    it("rewrites wp-config.php for the database it names and sets the variables", async () => {
        const config = join(scratch, "backup", "homedir", "public_html", "wp-config.php");
        await writeFile(config, WP);
        // Read before the scratch folder goes: the copy is stored before then.
        let stored = "";
        storeSourceFolder.mockImplementationOnce(async () => {
            stored = await readFile(config, "utf8");
            return {};
        });
        const result = await importCpanelBackup(input());
        expect(stored).toContain("define( 'DB_NAME', 'acct_wp_new' );");
        expect(stored).toContain("define( 'DB_HOST', 'mysql-db-acct_wp' );");
        expect(stored).toContain("define( 'DB_PASSWORD', 'pa\\'ss' );");
        expect(stored).toContain("// define( 'DB_NAME', 'commented' );");
        expect(stored).toContain("$table_prefix = 'wp_';");
        const call = setEnvVars.mock.calls.find((args) => args[1] === "app-main.test");
        expect(call?.[3].map((entry) => entry.key)).toEqual(["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "DATABASE_URL"]);
        // The addon site has no config and two databases to choose from: left alone, quietly.
        expect(setEnvVars.mock.calls.some((args) => args[1] === "app-addon.test")).toBe(false);
        expect(result.warnings.some((warning) => warning.code === "databaseUnlinked")).toBe(false);
    });

    it("warns when the config names a database that did not come over", async () => {
        await writeFile(join(scratch, "backup", "homedir", "public_html", "wp-config.php"), WP.replace("acct_wp", "other"));
        const result = await importCpanelBackup(input());
        expect(result.warnings).toContainEqual({ code: "databaseUnlinked", name: "main.test" });
    });

    it("picks the named database, else the only one", () => {
        const one = [{ original: "a", id: "1" }];
        const two = [...one, { original: "b", id: "2" }];
        expect(pickDatabase("b", two)?.id).toBe("2");
        expect(pickDatabase("c", two)).toBeUndefined();
        expect(pickDatabase(null, one)?.id).toBe("1");
        expect(pickDatabase("c", one)?.id).toBe("1");
    });
});
