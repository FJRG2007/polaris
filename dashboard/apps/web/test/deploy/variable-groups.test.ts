/**
 * Variable groups: sets of variables a service links, layered under the
 * environment's shared variables and the service's own.
 *
 * What is pinned here: the order a service resolves in, a group's secret stored
 * sealed and opened again only for the container, who may change or link a
 * group, what a change reaches, and a copy of a service keeping its groups
 * (without a secret one, for a preview).
 */

import * as core from "@polaris/core";
import { encryptSecret } from "@polaris/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

const db = vi.hoisted(() => ({
    variableGroup: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    variableGroupLink: {
        findMany: vi.fn(),
        upsert: vi.fn(),
        createMany: vi.fn(),
        count: vi.fn()
    },
    envVar: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    application: { findUnique: vi.fn() }
}));
const access = vi.hoisted(() => ({
    requireApplicationAccess: vi.fn(),
    requireEnvScopeAccess: vi.fn(),
    resolveOrgAccess: vi.fn(),
    orgCan: vi.fn()
}));

vi.mock("@polaris/db", () => ({ prisma: db }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: MASTER_KEY }) }));
vi.mock("@/lib/deploy-project-access", () => ({
    requireApplicationAccess: access.requireApplicationAccess,
    requireEnvScopeAccess: access.requireEnvScopeAccess
}));
vi.mock("@/lib/orgs/org-service", () => ({
    resolveOrgAccess: access.resolveOrgAccess,
    orgCan: access.orgCan
}));
vi.mock("@/lib/restore-points/service", () => ({
    capture: async () => undefined,
    restoreKeys: { env: () => "env" }
}));

const groups = await import("@/lib/deploy/variable-groups");
const { setEnvVar } = await import("@/lib/env-var-service");
const { decryptedValue } = await import("@/lib/deploy/env-values");

const ME = { id: "user-1", isAdmin: false };
const ORG_GROUP = { id: "group-1", name: "Payments", ownerId: "user-9", orgId: "org-1" };

/** A row as the database stores it: a secret sealed, a plain value in the clear. */
function row(scopeType: string, scopeId: string, key: string, value: string, isSecret = false) {
    if (!isSecret)
        return { scopeType, scopeId, key, value, isSecret, encryptedValue: null, valueNonce: null, valueKeyId: null };
    const blob = encryptSecret(value, MASTER_KEY);
    return {
        scopeType,
        scopeId,
        key,
        value: null,
        isSecret,
        encryptedValue: blob.ciphertext,
        valueNonce: blob.nonce,
        valueKeyId: blob.keyId
    };
}

/** The reader belongs to the organization; `manage` decides whether they edit. */
function member(manage: boolean): void {
    access.resolveOrgAccess.mockResolvedValue({ role: manage ? "admin" : "member" });
    access.orgCan.mockReturnValue(manage);
}

beforeEach(() => {
    for (const table of Object.values(db)) for (const fn of Object.values(table)) fn.mockReset();
    for (const fn of Object.values(access)) fn.mockReset();
});

describe("resolution order", () => {
    it("layers linked groups in link order, then shared variables, then the service's own", async () => {
        db.variableGroupLink.findMany.mockResolvedValue([
            { group: { id: "g-a", name: "Database" } },
            { group: { id: "g-b", name: "Payments" } }
        ]);
        db.envVar.findMany.mockResolvedValue([
            row("group", "g-a", "REGION", "eu"),
            row("group", "g-a", "DATABASE_URL", "postgres://group"),
            row("group", "g-b", "REGION", "us"),
            row("group", "g-b", "STRIPE_KEY", "sk_test_fixture", true)
        ]);
        db.application.findUnique.mockResolvedValue({ environment: { pullRequest: null } });
        const layers = await groups.groupLayers("app-1");
        expect(db.envVar.findMany.mock.calls[0][0].where).not.toHaveProperty("isSecret");
        expect(layers.map((layer) => layer.source)).toEqual([
            { kind: "group", id: "g-a", name: "Database" },
            { kind: "group", id: "g-b", name: "Payments" }
        ]);
        // The secret is opened for the container.
        expect(layers[1].values.STRIPE_KEY).toBe("sk_test_fixture");

        const env = core.flattenLayers([
            ...layers,
            { source: { kind: "environment" }, values: { DATABASE_URL: "postgres://shared" } },
            { source: { kind: "service" }, values: { REGION: "service" } }
        ]);
        expect(env).toEqual({
            REGION: "service",
            DATABASE_URL: "postgres://shared",
            STRIPE_KEY: "sk_test_fixture"
        });
    });

    it("gives a preview's service no group secret, however it was linked", async () => {
        db.variableGroupLink.findMany.mockResolvedValue([{ group: { id: "g-b", name: "Payments" } }]);
        db.application.findUnique.mockResolvedValue({ environment: { pullRequest: 42 } });
        db.envVar.findMany.mockResolvedValue([row("group", "g-b", "REGION", "us")]);
        const layers = await groups.groupLayers("app-1");
        expect(db.envVar.findMany.mock.calls[0][0].where).toEqual({
            scopeType: "group",
            scopeId: { in: ["g-b"] },
            isSecret: false
        });
        expect(layers[0].values).toEqual({ REGION: "us" });
    });

    it("answers nothing, without a query for rows, for a service with no groups", async () => {
        db.variableGroupLink.findMany.mockResolvedValue([]);
        expect(await groups.groupLayers("app-1")).toEqual([]);
        expect(db.envVar.findMany).not.toHaveBeenCalled();
    });

    it("shows the screen keys and sources, but no secret and no value of a group it may not read", async () => {
        db.variableGroupLink.findMany.mockResolvedValue([
            { group: { id: "g-own", name: "Mine", ownerId: "user-1", orgId: null } },
            { group: { id: "g-other", name: "Theirs", ownerId: "user-2", orgId: null } }
        ]);
        db.envVar.findMany.mockResolvedValue([
            { scopeType: "group", scopeId: "g-own", key: "TOKEN", value: null, isSecret: true },
            { scopeType: "group", scopeId: "g-own", key: "MODE", value: "fast", isSecret: false },
            { scopeType: "group", scopeId: "g-other", key: "HIDDEN", value: "plain", isSecret: false },
            { scopeType: "application", scopeId: "app-1", key: "MODE", value: "slow", isSecret: false }
        ]);
        const resolved = await groups.resolvedVariables(ME, "app-1", "env-1");
        const byKey = Object.fromEntries(resolved.map((one) => [one.key, one]));
        expect(byKey.MODE.value).toBe("slow");
        expect(byKey.MODE.source).toEqual({ kind: "service" });
        expect(byKey.MODE.overridden).toEqual([{ kind: "group", id: "g-own", name: "Mine" }]);
        expect(byKey.TOKEN).toMatchObject({ value: null, isSecret: true });
        expect(byKey.HIDDEN).toMatchObject({ value: null, isSecret: false });
    });
});

describe("a group's secret at rest", () => {
    it("is stored sealed, with no plaintext in the row, and opens to the same value", async () => {
        const plaintext = "sk_live_fixture_0123456789";
        db.variableGroup.findFirst.mockResolvedValue({ id: "group-1" });
        db.envVar.findFirst.mockResolvedValue(null);
        db.envVar.create.mockResolvedValue({});

        await setEnvVar("group", "group-1", "owner-1", { key: "STRIPE_KEY", value: plaintext, isSecret: true });

        const data = db.envVar.create.mock.calls[0][0].data;
        expect(data).toMatchObject({ scopeType: "group", scopeId: "group-1", key: "STRIPE_KEY", isSecret: true });
        expect(data.value).toBeNull();
        const stored = JSON.stringify(data);
        expect(stored).not.toContain(plaintext);
        expect(Buffer.from(data.encryptedValue).includes(Buffer.from(plaintext))).toBe(false);
        expect(decryptedValue(data)).toBe(plaintext);
    });

    it("is refused on a group the owner does not hold", async () => {
        db.variableGroup.findFirst.mockResolvedValue(null);
        await expect(
            setEnvVar("group", "group-1", "someone-else", { key: "A", value: "b", isSecret: true })
        ).rejects.toThrow("Variable group not found");
        expect(db.envVar.create).not.toHaveBeenCalled();
    });
});

describe("who may change a group", () => {
    it("lets an organization member read it but not change it", async () => {
        member(false);
        db.variableGroup.findUnique.mockResolvedValue(ORG_GROUP);
        await expect(groups.requireGroup(ME, "group-1", "read")).resolves.toMatchObject({
            canRead: true,
            canEdit: false
        });
        await expect(
            groups.updateGroup(ME, "group-1", { name: "Renamed", description: "" })
        ).rejects.toMatchObject({ code: "readOnly" });
        expect(db.variableGroup.update).not.toHaveBeenCalled();
    });

    it("answers a stranger as if the group were not there", async () => {
        access.resolveOrgAccess.mockResolvedValue(null);
        access.orgCan.mockReturnValue(false);
        db.variableGroup.findUnique.mockResolvedValue(ORG_GROUP);
        await expect(groups.requireGroup(ME, "group-1", "read")).rejects.toMatchObject({ code: "notFound" });
    });

    it("keeps a personal group to its owner", async () => {
        db.variableGroup.findUnique.mockResolvedValue({ id: "g", name: "x", ownerId: "user-2", orgId: null });
        expect(await groups.groupRights(ME, "g")).toBeNull();
    });
});

describe("linking a group", () => {
    it("refuses a group the reader cannot read, before writing anything", async () => {
        access.resolveOrgAccess.mockResolvedValue(null);
        access.orgCan.mockReturnValue(false);
        db.variableGroup.findUnique.mockResolvedValue(ORG_GROUP);
        await expect(groups.linkGroup(ME, "app-1", "group-1")).rejects.toMatchObject({ code: "notFound" });
        expect(db.variableGroupLink.upsert).not.toHaveBeenCalled();
    });

    it("refuses a readable group from another workspace than the project's", async () => {
        member(true);
        db.variableGroup.findUnique.mockResolvedValue(ORG_GROUP);
        db.application.findUnique.mockResolvedValue({
            environment: { project: { ownerId: "user-1", orgId: "org-2" } }
        });
        await expect(groups.linkGroup(ME, "app-1", "group-1")).rejects.toMatchObject({ code: "otherShelf" });
        expect(db.variableGroupLink.upsert).not.toHaveBeenCalled();
    });

    it("links a group on the project's shelf above the ones already linked", async () => {
        member(false);
        db.variableGroup.findUnique.mockResolvedValue(ORG_GROUP);
        db.application.findUnique.mockResolvedValue({
            environment: { project: { ownerId: "user-1", orgId: "org-1" } }
        });
        db.variableGroupLink.findMany.mockResolvedValue([{ groupId: "other", position: 2 }]);
        db.envVar.findMany.mockResolvedValue([]);
        await groups.linkGroup(ME, "app-1", "group-1");
        expect(db.variableGroupLink.upsert.mock.calls[0][0].create).toMatchObject({
            groupId: "group-1",
            applicationId: "app-1",
            position: 3
        });
    });

    it("refuses a group holding a secret to a reader who could not reveal it", async () => {
        member(false);
        db.variableGroup.findUnique.mockResolvedValue(ORG_GROUP);
        db.envVar.findMany.mockResolvedValue([{ scopeId: "group-1" }]);
        await expect(groups.linkGroup(ME, "app-1", "group-1")).rejects.toMatchObject({ code: "secretLink" });
        expect(db.variableGroupLink.upsert).not.toHaveBeenCalled();
    });

    it("lets the group's editor link it with its secrets", async () => {
        member(true);
        db.variableGroup.findUnique.mockResolvedValue(ORG_GROUP);
        db.application.findUnique.mockResolvedValue({
            environment: { project: { ownerId: "user-1", orgId: "org-1" } }
        });
        db.variableGroupLink.findMany.mockResolvedValue([]);
        await groups.linkGroup(ME, "app-1", "group-1");
        expect(db.envVar.findMany).not.toHaveBeenCalled();
        expect(db.variableGroupLink.upsert).toHaveBeenCalled();
    });

    it("offers a reader only the groups without a secret", async () => {
        member(false);
        db.application.findUnique.mockResolvedValue({
            environment: { project: { ownerId: "user-1", orgId: "org-1" } }
        });
        db.variableGroup.findMany.mockResolvedValue([
            { id: "g-plain", name: "Plain" },
            { id: "g-secret", name: "Keys" }
        ]);
        db.envVar.findMany.mockResolvedValue([{ scopeId: "g-secret" }]);
        expect(await groups.linkableGroups(ME, "app-1")).toEqual([{ id: "g-plain", name: "Plain" }]);
    });

    it("stops at the most groups a service may link", async () => {
        member(false);
        db.variableGroup.findUnique.mockResolvedValue(ORG_GROUP);
        db.application.findUnique.mockResolvedValue({
            environment: { project: { ownerId: "user-1", orgId: "org-1" } }
        });
        db.envVar.findMany.mockResolvedValue([]);
        db.variableGroupLink.findMany.mockResolvedValue(
            Array.from({ length: core.VARIABLE_GROUP_LINKS_MAX }, (_, index) => ({
                groupId: `g-${index}`,
                position: index
            }))
        );
        await expect(groups.linkGroup(ME, "app-1", "group-1")).rejects.toMatchObject({ code: "tooMany" });
    });
});

describe("what a change to a group reaches", () => {
    it("counts only running services that are not in the bin", async () => {
        db.variableGroupLink.findMany.mockResolvedValue([{ applicationId: "a" }, { applicationId: "b" }]);
        expect(await groups.deployedServicesLinking("group-1")).toEqual(["a", "b"]);
        expect(db.variableGroupLink.findMany.mock.calls[0][0].where).toEqual({
            groupId: "group-1",
            application: { currentDeploymentId: { not: null }, binnedAt: null }
        });
    });

    it("redeploys the linked services the actor may deploy and skips the rest", async () => {
        db.variableGroupLink.findMany.mockResolvedValue([{ applicationId: "a" }, { applicationId: "b" }]);
        access.requireApplicationAccess.mockImplementation(async (applicationId: string) => {
            if (applicationId === "b") throw new Error("no");
            return { ownerId: "owner-a" };
        });
        const restart = vi.fn().mockResolvedValue(undefined);
        expect(await groups.redeployLinked(ME, "group-1", restart)).toEqual({ started: 1, skipped: 1 });
        expect(restart).toHaveBeenCalledWith("a", "owner-a");
        expect(access.requireApplicationAccess).toHaveBeenCalledWith("a", "user-1", "deploy.run");
    });
});

describe("where a group is used", () => {
    it("lists the services the reader may open and only counts the rest", async () => {
        const service = (id: string, deployed: boolean) => ({
            application: {
                id,
                name: `svc-${id}`,
                currentDeploymentId: deployed ? "d" : null,
                environment: { name: "production", project: { id: `p-${id}`, name: `Project ${id}` } }
            }
        });
        db.variableGroupLink.findMany.mockResolvedValue([service("a", true), service("b", false)]);
        access.requireApplicationAccess.mockImplementation(async (applicationId: string) => {
            if (applicationId === "b") throw new Error("no");
            return { ownerId: "owner-a" };
        });
        expect(await groups.servicesLinking(ME, "group-1")).toEqual({
            services: [
                {
                    applicationId: "a",
                    name: "svc-a",
                    projectId: "p-a",
                    projectName: "Project a",
                    environmentName: "production",
                    deployed: true
                }
            ],
            hidden: 1
        });
        expect(access.requireApplicationAccess).toHaveBeenCalledWith("a", "user-1", "project.read");
    });
});

describe("a copy of a service", () => {
    const LINKS = [
        { groupId: "g-plain", position: 0, createdById: "u" },
        { groupId: "g-secret", position: 1, createdById: "u" }
    ];

    it("links the same groups in the same order", async () => {
        db.variableGroupLink.findMany.mockResolvedValue(LINKS);
        expect(await groups.copyGroupLinks("app-1", "app-2")).toEqual({ withheld: [] });
        expect(db.variableGroupLink.createMany.mock.calls[0][0].data).toEqual([
            { groupId: "g-plain", position: 0, createdById: "u", applicationId: "app-2" },
            { groupId: "g-secret", position: 1, createdById: "u", applicationId: "app-2" }
        ]);
    });

    it("leaves a group holding a secret off a preview and names the secret withheld", async () => {
        db.variableGroupLink.findMany.mockResolvedValue(LINKS);
        db.envVar.findMany.mockResolvedValue([{ scopeId: "g-secret", key: "STRIPE_KEY" }]);
        expect(await groups.copyGroupLinks("app-1", "app-2", { secrets: false })).toEqual({
            withheld: ["STRIPE_KEY"]
        });
        expect(db.variableGroupLink.createMany.mock.calls[0][0].data).toEqual([
            { groupId: "g-plain", position: 0, createdById: "u", applicationId: "app-2" }
        ]);
    });
});
