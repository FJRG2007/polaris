/**
 * Syncing one environment into another, against an in-memory store.
 *
 * What is pinned here is what the owner asked of the feature: each item needs
 * the capability editing it by hand takes, a variable's value never reaches the
 * preview, domains are never copied, a volume only the receiving side has is
 * kept, removals are opt-in and parked in the changeset, and applying the same
 * sync twice does nothing the second time. Copying a whole environment goes
 * through the same per-service copy, so its behaviour is pinned too.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECT_CAPABILITIES, type ProjectCapability } from "@polaris/core";

type Row = Record<string, unknown> & { id: string };

const db = {
    environments: [] as Row[],
    applications: [] as Row[],
    volumes: [] as Row[],
    envVars: [] as Row[],
    groupLinks: [] as Row[]
};
let counter = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

function application(environmentId: string, name: string, extra: Partial<Row> = {}): Row {
    return {
        id: nextId(),
        environmentId,
        name,
        slug: name.toLowerCase(),
        binnedAt: null,
        targetId: "target-1",
        sourceType: "image",
        sourceConfig: JSON.stringify({ image: "nginx:1" }),
        buildConfig: null,
        healthcheck: null,
        deployBranch: null,
        autoDeploy: false,
        waitForCi: false,
        commitFilter: null,
        watchPaths: null,
        replicas: 1,
        autoscale: null,
        cpuLimit: null,
        memoryLimitMb: null,
        useGpu: false,
        restartPolicy: "unless-stopped",
        restartMaxRetries: 0,
        privateNetwork: null,
        publishPort: false,
        publishPortChosen: false,
        edgeConfig: null,
        ...extra
    };
}

function withRelations(app: Row) {
    return {
        ...app,
        volumes: db.volumes.filter((volume) => volume.applicationId === app.id),
        variableGroupLinks: db.groupLinks
            .filter((link) => link.applicationId === app.id)
            .map((link) => ({ ...link, group: { name: `group-${link.groupId}` } }))
    };
}

const domainTouched = vi.fn();

const prismaMock = {
    environment: {
        findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
            const found = db.environments.find(
                (env) =>
                    (where.id === undefined || env.id === where.id) &&
                    (where.slug === undefined || env.slug === where.slug) &&
                    (where.projectId === undefined || env.projectId === where.projectId)
            );
            if (!found) return null;
            return {
                ...found,
                project: { id: found.projectId, slug: "shop" },
                applications: db.applications
                    .filter((app) => app.environmentId === found.id && !app.binnedAt)
                    .map(withRelations),
                databases: []
            };
        }),
        create: vi.fn(async ({ data }: { data: Row }) => {
            const row = { ...data, id: nextId() } as Row;
            db.environments.push(row);
            return row;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
            const row = db.environments.find((env) => env.id === where.id)!;
            Object.assign(row, data);
            return row;
        })
    },
    application: {
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
            const row = db.applications.find((app) => app.id === where.id)!;
            Object.assign(row, data);
            return row;
        }),
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => [])
    },
    volume: {
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
            Object.assign(db.volumes.find((volume) => volume.id === where.id)!, data);
        }),
        delete: vi.fn(),
        deleteMany: vi.fn()
    },
    envVar: {
        findMany: vi.fn(async ({ where }: { where: { OR: { scopeType: string; scopeId: unknown }[] } }) =>
            db.envVars.filter((row) =>
                where.OR.some(
                    (scope) =>
                        scope.scopeType === row.scopeType &&
                        (typeof scope.scopeId === "string"
                            ? scope.scopeId === row.scopeId
                            : (scope.scopeId as { in: string[] }).in.includes(row.scopeId as string))
                )
            )
        ),
        upsert: vi.fn(
            async ({ create, update }: { create: Row; update: Row }) => {
                const existing = db.envVars.find(
                    (row) =>
                        row.scopeType === create.scopeType &&
                        row.scopeId === create.scopeId &&
                        row.key === create.key
                );
                if (existing) Object.assign(existing, update);
                else db.envVars.push({ ...create, id: nextId() });
            }
        ),
        deleteMany: vi.fn(async ({ where }: { where: Row }) => {
            db.envVars = db.envVars.filter(
                (row) =>
                    !(row.scopeType === where.scopeType && row.scopeId === where.scopeId && (where.key === undefined || row.key === where.key))
            );
        })
    },
    variableGroupLink: { deleteMany: vi.fn(), createMany: vi.fn() },
    wafRule: { deleteMany: vi.fn() },
    domain: new Proxy({}, { get: () => domainTouched }),
    managedDatabase: { findMany: vi.fn(async () => []) }
};

vi.mock("@polaris/db", () => ({ prisma: prismaMock }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k".repeat(64) }) }));
vi.mock("@/lib/deploy/env-values", () => ({
    decryptedValue: (row: Row) => (row.value as string | null) ?? null,
    copyScopeValues: vi.fn(
        async (from: { scopeId: string }, to: { scopeType: string; scopeId: string }, options: { secrets: boolean }) => {
            const withheld: string[] = [];
            for (const row of db.envVars.filter((one) => one.scopeId === from.scopeId)) {
                if (row.isSecret && !options.secrets) {
                    withheld.push(row.key as string);
                    continue;
                }
                db.envVars.push({ ...row, id: nextId(), scopeType: to.scopeType, scopeId: to.scopeId });
            }
            return { withheld };
        }
    )
}));
vi.mock("@/lib/deploy/variable-groups", () => ({ copyGroupLinks: vi.fn(async () => ({ withheld: [] })) }));
vi.mock("@/lib/waf-service", () => ({ copyWafRule: vi.fn(async () => undefined) }));
vi.mock("@/lib/setting-store", () => ({ setSetting: vi.fn() }));
vi.mock("@/lib/activity/activity", () => ({ recordMany: vi.fn(async () => undefined) }));
vi.mock("@/lib/notification-service", () => ({ createNotification: vi.fn() }));
vi.mock("@/lib/github-service", () => ({ listOpenPullRequests: vi.fn(), pullRequestIsOpen: vi.fn() }));
vi.mock("@/lib/github-access", () => ({ githubTokenForOwner: vi.fn() }));
vi.mock("@/lib/orgs/quota-service", () => ({
    assertOrgReservation: vi.fn(async () => undefined),
    orgIdOfEnvironment: vi.fn(async () => null)
}));
const createApplication = vi.fn(async (_owner: string, input: Row & { sourceConfig: unknown }) => {
    const row = application(input.environmentId as string, input.name as string, {
        ...input,
        sourceConfig: JSON.stringify(input.sourceConfig)
    });
    db.applications.push(row);
    return row;
});
const deleteApplication = vi.fn();
const setEnvironmentNetworkMode = vi.fn(async (id: string, _owner: string, mode: string) => {
    db.environments.find((env) => env.id === id)!.networkMode = mode;
});
vi.mock("@/lib/deploy-service", () => ({ createApplication, deleteApplication, setEnvironmentNetworkMode }));
const createVolume = vi.fn(async (_owner: string, input: Row) => {
    db.volumes.push({ ...input, id: nextId() });
});
vi.mock("@/lib/deploy-volume-service", () => ({ createVolume }));
const stageChange = vi.fn(async () => undefined);
vi.mock("@/lib/deploy-staged-changes", () => ({ stageChange }));

const sync = await import("@/lib/deploy/environment-sync");
const { cloneEnvironment } = await import("@/lib/deploy/environments");

const EVERYTHING = { source: PROJECT_CAPABILITIES, target: PROJECT_CAPABILITIES };
const OWNER = "owner-1";
let production: Row;
let staging: Row;

function variable(scopeId: string, key: string, value: string, extra: Partial<Row> = {}): Row {
    return {
        id: nextId(),
        scopeType: "application",
        scopeId,
        key,
        value,
        isSecret: false,
        sealed: false,
        generator: null,
        encryptedValue: null,
        valueNonce: null,
        valueKeyId: null,
        ...extra
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    counter = 0;
    db.environments = [];
    db.applications = [];
    db.volumes = [];
    db.envVars = [];
    db.groupLinks = [];
    production = { id: nextId(), projectId: "project-1", name: "production", slug: "production", networkMode: "environment", branch: null, layout: null };
    staging = { id: nextId(), projectId: "project-1", name: "staging", slug: "staging", networkMode: "shared", branch: null, layout: null };
    db.environments.push(production, staging);

    const api = application(production.id as string, "API", { replicas: 2, restartPolicy: "always" });
    const web = application(production.id as string, "Web");
    db.applications.push(api, web);
    db.volumes.push({ id: nextId(), applicationId: api.id, name: "data", mountPath: "/data", kind: "volume", connectionId: null, sizeLimit: null });
    db.envVars.push(
        variable(api.id, "DATABASE_PASSWORD", "hunter2-secret", { isSecret: true }),
        variable(api.id, "LOG_LEVEL", "debug")
    );

    const stagingApi = application(staging.id as string, "API");
    const legacy = application(staging.id as string, "Legacy");
    db.applications.push(stagingApi, legacy);
    db.volumes.push({ id: nextId(), applicationId: stagingApi.id, name: "scratch", mountPath: "/scratch", kind: "volume", connectionId: null, sizeLimit: null });
    db.envVars.push(variable(stagingApi.id, "LOG_LEVEL", "info"));
});

describe("previewing a sync", () => {
    it("refuses each item to someone without the capability editing it by hand takes", async () => {
        const readOnly: ProjectCapability[] = ["project.read"];
        const preview = await sync.previewSync(production.id, staging.id, OWNER, { source: readOnly, target: readOnly });
        expect(preview.diff.items.length).toBeGreaterThan(0);
        for (const item of preview.diff.items) expect(preview.refusals[item.id]).toBeTruthy();
        expect(preview.refusals["add:web"]).toBe("needsCreate");
        expect(preview.refusals["remove:legacy"]).toBe("needsDelete");
        expect(preview.refusals["setting:api:replicas"]).toBe("needsConfigure");
        expect(preview.refusals["var:api:LOG_LEVEL"]).toBe("needsVariables");
        expect(preview.refusals.network).toBe("needsSettings");

        const outcome = await sync.applySync({
            sourceId: production.id,
            targetId: staging.id,
            ownerId: OWNER,
            actorId: "user-1",
            items: preview.diff.items.map((item) => item.id),
            reach: { source: readOnly, target: readOnly }
        });
        expect(outcome.applied).toEqual([]);
        expect(outcome.refused).toHaveLength(preview.diff.items.length);
        expect(createApplication).not.toHaveBeenCalled();
        expect(prismaMock.envVar.upsert).not.toHaveBeenCalled();
    });

    it("never carries a variable's value or a digest of it", async () => {
        const preview = await sync.previewSync(production.id, staging.id, OWNER, EVERYTHING);
        const said = JSON.stringify(preview);
        expect(said).toContain("DATABASE_PASSWORD");
        expect(said).not.toContain("hunter2-secret");
        expect(said).not.toContain("debug");
        expect(said).not.toMatch(/[0-9a-f]{64}/);
        expect(preview.diff.items.find((item) => item.id === "var:api:DATABASE_PASSWORD")?.secret).toBe(true);
    });

    it("keeps a volume only the receiving side has, and leaves removals unticked", async () => {
        const preview = await sync.previewSync(production.id, staging.id, OWNER, EVERYTHING);
        expect(preview.diff.keptVolumes).toEqual([{ service: "API", name: "scratch" }]);
        expect(preview.diff.items.some((item) => item.kind === "volume" && item.key === "scratch")).toBe(false);
        const removals = preview.diff.items.filter((item) => item.change === "removed");
        expect(removals.length).toBeGreaterThan(0);
        for (const item of removals) expect(item.recommended).toBe(false);
    });
});

describe("applying a sync", () => {
    async function applyAll() {
        const preview = await sync.previewSync(production.id, staging.id, OWNER, EVERYTHING);
        return sync.applySync({
            sourceId: production.id,
            targetId: staging.id,
            ownerId: OWNER,
            actorId: "user-1",
            items: preview.diff.items.map((item) => item.id),
            reach: EVERYTHING
        });
    }

    it("parks a removal in the changeset, keeps volumes, and never touches a domain", async () => {
        const outcome = await applyAll();
        expect(outcome.failures).toEqual([]);
        expect(stageChange).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "service.delete", targetName: "Legacy" })
        );
        expect(deleteApplication).not.toHaveBeenCalled();
        expect(prismaMock.volume.delete).not.toHaveBeenCalled();
        expect(prismaMock.volume.deleteMany).not.toHaveBeenCalled();
        expect(db.volumes.some((volume) => volume.name === "scratch")).toBe(true);
        expect(domainTouched).not.toHaveBeenCalled();
        // The added service gets a volume of its own, empty, never the source's.
        const added = db.applications.find((app) => app.environmentId === staging.id && app.slug === "web");
        expect(added).toBeTruthy();
        expect(outcome.affected).toContain(added!.id);
    });

    it("does nothing the second time", async () => {
        await applyAll();
        // The parked removal is still pending, which is the one difference left.
        const again = await sync.previewSync(production.id, staging.id, OWNER, EVERYTHING);
        expect(again.diff.items.map((item) => item.id)).toEqual(["remove:legacy"]);
        vi.clearAllMocks();
        const second = await applyAll();
        expect(second.applied).toEqual(["remove:legacy"]);
        expect(createApplication).not.toHaveBeenCalled();
        expect(prismaMock.envVar.upsert).not.toHaveBeenCalled();
        expect(prismaMock.application.update).not.toHaveBeenCalled();
    });
});

describe("copying a whole environment", () => {
    it("copies every service the way it did before the copy was shared with sync", async () => {
        const made = await cloneEnvironment(production.id, OWNER, { name: "QA", branch: "feature/x" });
        const copies = db.applications.filter((app) => app.environmentId === made.id);
        expect(copies.map((app) => app.slug).sort()).toEqual(["api", "web"]);
        const api = copies.find((app) => app.slug === "api")!;
        expect(createApplication).toHaveBeenCalledWith(
            OWNER,
            expect.objectContaining({
                environmentId: made.id,
                name: "API",
                sourceType: "image",
                sourceConfig: { image: "nginx:1" },
                autoDeploy: false,
                deployBranch: null,
                keepReleases: false,
                publishPort: false
            })
        );
        expect(api.replicas).toBe(2);
        expect(db.envVars.filter((row) => row.scopeId === api.id).map((row) => row.key).sort()).toEqual([
            "DATABASE_PASSWORD",
            "LOG_LEVEL"
        ]);
        expect(createVolume).toHaveBeenCalledWith(OWNER, {
            applicationId: api.id,
            name: "data",
            mountPath: "/data",
            kind: "volume"
        });
        expect(made.withheld).toEqual([]);
        expect(domainTouched).not.toHaveBeenCalled();
    });

    it("withholds secrets from a preview copy", async () => {
        const made = await cloneEnvironment(production.id, OWNER, {
            name: "PR 7",
            preview: { pullRequest: 7, repo: "acme/shop", sha: "abc" } as never
        });
        expect(made.withheld).toEqual(["DATABASE_PASSWORD"]);
    });
});
