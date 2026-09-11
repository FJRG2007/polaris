/**
 * Every database deploy is on the audit trail, whatever started it - the Deploy
 * button, a settings change, a recovery, a maintenance window nobody pressed.
 * `deployDatabase` writes the entry itself, crediting who asked and never the
 * project's owner standing in for nobody.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const DB = "0192f1e2-7b5c-7d3e-8f00-00000000000a";
const OWNER = "0192f1e2-7b5c-7d3e-8f00-00000000000b";

const { create, recordDeployAudit } = vi.hoisted(() => ({
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "dep-1", ...data })),
    recordDeployAudit: vi.fn(async () => undefined)
}));

// A database on an existing instance: provisioned by statements, inline.
const row = {
    id: DB,
    targetId: "target-1",
    parentId: "parent-1",
    engine: "postgres",
    privileges: "owner",
    encryptedCredential: Buffer.from("x"),
    credentialNonce: Buffer.from("y"),
    credentialKeyId: "k",
    parent: { id: "parent-1", containerName: "shop-pg-ab12", target: { id: "target-1", kind: "local" } }
};

vi.mock("@polaris/db", () => ({
    prisma: {
        managedDatabase: { findFirst: async () => row, update: async () => row },
        deployment: { create, update: async () => ({}) }
    }
}));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "unused" }) }));
vi.mock("@polaris/storage", () => ({
    encryptCredentials: vi.fn(),
    decryptCredentials: () => ({ username: "shop", password: "secret", database: "shop" })
}));
vi.mock("@/lib/deploy/runtime", () => ({
    getPorts: async () => ({ runIn: async () => ({ code: 0, output: "" }), dispose: async () => undefined })
}));
vi.mock("@/lib/deploy-service", () => ({
    deployLogPath: vi.fn(),
    enqueueOnTarget: vi.fn(),
    executeDeployment: vi.fn(),
    limitsOf: vi.fn()
}));
vi.mock("@/lib/deploy/service-networks", () => ({ networksForService: vi.fn() }));
vi.mock("@/lib/deploy-audit", () => ({ recordDeployAudit }));

const { deployDatabase } = await import("@/lib/database-service");

beforeEach(() => {
    create.mockClear();
    recordDeployAudit.mockClear();
});

describe("the audit entry a database deploy writes", () => {
    it("is written once, crediting who asked, with the deployment", async () => {
        await expect(deployDatabase(DB, OWNER, "member-1")).resolves.toBe("dep-1");
        expect(recordDeployAudit).toHaveBeenCalledTimes(1);
        expect(recordDeployAudit).toHaveBeenCalledWith({
            actorId: "member-1",
            action: "deploy.db.deploy",
            targetType: "database",
            targetId: DB,
            metadata: { deploymentId: "dep-1" }
        });
        expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ triggeredById: "member-1" }) });
    });

    it("credits nobody for a deploy nobody asked for, while the history still names the owner", async () => {
        await deployDatabase(DB, OWNER, null);
        expect(recordDeployAudit).toHaveBeenCalledWith(expect.objectContaining({ actorId: null }));
        expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ triggeredById: OWNER }) });
    });
});
