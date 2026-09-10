/**
 * A one-click service with more than one part comes up in the order it needs.
 *
 * The order is the feature: a Ghost started before its MySQL answers exits, is
 * restarted and has its deploy counted as failed, and a Gitea whose admin command
 * runs before the service is serving creates nobody. So what happens, and in
 * which order, is asserted - and every way it can stop is asserted to leave a
 * line on the service, because a setup that fails where nobody can see it is a
 * service that looks fine and has no account on it.
 */

import { serviceTemplate } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "018f2b7a-0000-7000-8000-0000000000a1";
const USER = "018f2b7a-0000-7000-8000-0000000000a2";
const ENV = "018f2b7a-0000-7000-8000-0000000000b1";
const TARGET = "018f2b7a-0000-7000-8000-0000000000c1";
const APP = "018f2b7a-0000-7000-8000-0000000000d1";

const calls: string[] = [];
const lines: { action: string; fromValue: string | null; toValue: string | null }[] = [];
const variables = new Map<string, { key: string; value: string; isSecret: boolean }[]>();

let databaseFailure: string | null = null;
let deployFailure: string | null = null;
let readinessAnswers: number[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        application: {
            findMany: async () => [{ slug: "blog" }],
            findUnique: async () => ({ currentDeploymentId: "dep-1" }),
            findFirst: async () => ({
                id: APP,
                slug: "blog",
                currentDeploymentId: "dep-1",
                desiredState: "running",
                target: { id: TARGET },
                environment: { project: { slug: "site" } }
            })
        },
        managedDatabase: { findMany: async () => [] }
    }
}));
vi.mock("@/lib/database-service", () => ({
    createDatabase: async (_owner: string, input: { name: string }) => {
        calls.push(`create database ${input.name}`);
        return { id: "db-1", slug: input.name };
    },
    deployDatabaseAndWait: async () => {
        calls.push("deploy database");
        return databaseFailure;
    }
}));
vi.mock("@/lib/deploy-service", () => ({
    createApplication: async (_owner: string, input: { name: string }) => {
        calls.push(`create service ${input.name}`);
        return { id: "companion-1", slug: input.name };
    },
    deployAndWait: async (id: string) => {
        calls.push(`deploy and wait ${id}`);
        return null;
    },
    deployApplication: async (id: string) => {
        calls.push(`deploy ${id}`);
        return "dep-1";
    },
    awaitDeployment: async () => {
        calls.push("wait for the deploy");
        return deployFailure;
    }
}));
vi.mock("@/lib/database-ops/ops", async () => {
    const actual = await vi.importActual<typeof import("@/lib/database-ops/ops")>("@/lib/database-ops/ops");
    return {
        DatabaseOperationError: actual.DatabaseOperationError,
        lastLine: actual.lastLine,
        instanceContext: async () => ({ name: "blog-db" }),
        withPorts: async (_context: unknown, work: (ports: unknown) => Promise<unknown>) => work({}),
        waitReady: async () => {
            calls.push("wait for the database to answer");
        }
    };
});
vi.mock("@/lib/activity/activity", () => ({
    record: async (entry: { action: string; fromValue: string | null; toValue: string | null }) => {
        lines.push(entry);
    },
    recordMany: async (entries: { action: string; fromValue: string | null; toValue: string | null }[]) => {
        lines.push(...entries);
    }
}));
vi.mock("@/lib/deploy-audit", () => ({ recordDeployAudit: async () => undefined }));
vi.mock("@/lib/env-var-service", () => ({
    setEnvVars: async (_scope: string, id: string, _owner: string, vars: { key: string; value: string; isSecret: boolean }[]) => {
        variables.set(id, vars);
        return vars.length;
    }
}));
vi.mock("@/lib/deploy-volume-service", () => ({
    createVolume: async (_owner: string, input: { name: string }) => {
        calls.push(`volume ${input.name}`);
    }
}));
vi.mock("@/lib/deploy/env-values", () => ({
    scopeValues: async () => ({ GITEA_ADMIN_PASSWORD: "hunter2-secret" })
}));
vi.mock("@/lib/deploy/releases", () => ({
    currentReleaseRef: async () => ({ name: "site-blog-1a2b", project: "site", address: "site-blog-1a2b" })
}));
vi.mock("@/lib/deploy/runtime", () => ({
    getPorts: async () => ({
        runIn: async (container: string, argv: string[]) => {
            const command = argv[2] ?? "";
            calls.push(`exec in ${container}: ${command.slice(0, 24)}`);
            if (command.includes("admin user list")) return { code: readinessAnswers.shift() ?? 0, output: "" };
            return { code: 0, output: "New user created with hunter2-secret\ndone\n" };
        },
        dispose: async () => undefined
    })
}));

const setup = await import("@/lib/deploy/template-setup");

beforeEach(() => {
    calls.length = 0;
    lines.length = 0;
    variables.clear();
    databaseFailure = null;
    deployFailure = null;
    readinessAnswers = [];
});

const service = { id: APP, slug: "blog", environmentId: ENV, targetId: TARGET };

describe("a template with a database", () => {
    it("names the database after the service and points the service at it by reference", async () => {
        const parts = await setup.addTemplateParts({ template: serviceTemplate("ghost")!, service, ownerId: OWNER, keepReleases: false });

        expect(parts.database).toEqual({ id: "db-1", name: "blog-db" });
        const vars = variables.get(APP) ?? [];
        expect(vars.find((entry) => entry.key === "database__connection__password")).toEqual({
            key: "database__connection__password",
            value: "${{blog-db.PASSWORD}}",
            isSecret: false
        });
        expect(calls).toContain("volume ghost-content");
    });

    it("deploys the database, waits for it to answer, and only then deploys the service", async () => {
        await setup.firstTemplateDeploy({
            template: serviceTemplate("ghost")!,
            applicationId: APP,
            parts: { database: { id: "db-1", name: "blog-db" }, companion: null },
            ownerId: OWNER,
            userId: USER
        });

        expect(calls).toEqual(["deploy database", "wait for the database to answer", `deploy ${APP}`]);
        expect(lines).toEqual([]);
    });

    it("does not deploy the service when its database does not come up, and says so on it", async () => {
        databaseFailure = "the deploy failed";
        await setup.firstTemplateDeploy({
            template: serviceTemplate("umami")!,
            applicationId: APP,
            parts: { database: { id: "db-1", name: "stats-db" }, companion: null },
            ownerId: OWNER,
            userId: USER
        });

        expect(calls).toEqual(["deploy database"]);
        expect(lines).toEqual([
            expect.objectContaining({ action: "setup-blocked", fromValue: "its database stats-db", toValue: "the deploy failed" })
        ]);
    });
});

describe("a template with a companion", () => {
    it("creates the companion beside the service and brings it up first", async () => {
        const parts = await setup.addTemplateParts({ template: serviceTemplate("kafka")!, service, ownerId: OWNER, keepReleases: false });
        expect(parts.companion).toEqual({ id: "companion-1", name: "blog-broker" });
        expect(variables.get("companion-1")?.find((entry) => entry.key === "KAFKA_ADVERTISED_LISTENERS")?.value).toBe(
            "PLAINTEXT://${{blog-broker.POLARIS_PRIVATE_DOMAIN}}:9092"
        );

        calls.length = 0;
        await setup.firstTemplateDeploy({ template: serviceTemplate("kafka")!, applicationId: APP, parts, ownerId: OWNER, userId: USER });
        expect(calls).toEqual(["deploy and wait companion-1", `deploy ${APP}`]);
    });
});

describe("a template with setup", () => {
    it("waits for the deploy, polls readiness, runs the command, and records it with secrets masked", async () => {
        readinessAnswers = [1, 0];
        await setup.firstTemplateDeploy({
            template: serviceTemplate("gitea")!,
            applicationId: APP,
            parts: { database: null, companion: null },
            ownerId: OWNER,
            userId: USER
        });

        expect(calls.slice(0, 2)).toEqual([`deploy ${APP}`, "wait for the deploy"]);
        expect(calls.slice(2).map((call) => call.split(":")[0])).toEqual([
            "exec in site-blog-1a2b",
            "exec in site-blog-1a2b",
            "exec in site-blog-1a2b"
        ]);
        expect(calls.at(-1)).toContain("su-exec git gitea admin");
        expect(lines).toEqual([
            expect.objectContaining({ action: "setup", fromValue: "Create the Gitea admin", toValue: "done" })
        ]);
        expect(JSON.stringify(lines)).not.toContain("hunter2-secret");
    });

    it("records that setup did not run when the first deploy did not come up", async () => {
        deployFailure = "the deploy failed";
        await setup.firstTemplateDeploy({
            template: serviceTemplate("freshrss")!,
            applicationId: APP,
            parts: { database: null, companion: null },
            ownerId: OWNER,
            userId: USER
        });

        expect(calls.some((call) => call.startsWith("exec"))).toBe(false);
        expect(lines).toEqual([
            expect.objectContaining({
                action: "setup-failed",
                fromValue: "Install FreshRSS",
                toValue: "The first deploy did not come up, so it did not run."
            })
        ]);
    });
});
