import { beforeEach, describe, expect, it, vi } from "vitest";

const targets = vi.fn();
const apps = vi.fn();
const projects = vi.fn();
const environments = vi.fn();
vi.mock("@polaris/db", () => ({
    prisma: {
        deployTarget: { findMany: (...args: unknown[]) => targets(...args) },
        application: { findMany: (...args: unknown[]) => apps(...args) },
        project: { findMany: (...args: unknown[]) => projects(...args) },
        environment: { findMany: (...args: unknown[]) => environments(...args) }
    }
}));
const requireAdmin = vi.fn(async () => ({ id: ADMIN }));
const requirePermission = vi.fn(async () => ({ id: ME }));
vi.mock("@/lib/session", () => ({
    requireAdmin: () => requireAdmin(),
    requirePermission: (permission: string) => requirePermission(permission)
}));
const projectAccess = vi.fn();
vi.mock("@/lib/deploy-project-access", () => ({
    requireProjectAccess: (...args: unknown[]) => projectAccess(...args)
}));
vi.mock("@/lib/deploy-service", () => ({ scopedProjectWhere: async () => ({ OR: [] }) }));
vi.mock("@/lib/deploy/managed-projects", () => ({ polarisProjectIds: async () => new Set<string>() }));
vi.unmock("@/app/(app)/deploy-target-options-actions");
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));

const { listDeployTargetOptionsAction, listServiceOptionsAction } =
    await import("@/app/(app)/deploy-target-options-actions");
const { encodeServerCursor } = await import("@/lib/server-options");

const ME = "11111111-1111-4111-8111-111111111111";
const ADMIN = "44444444-4444-4444-8444-444444444444";
const TARGET = "33333333-3333-4333-8333-333333333333";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const target = (n: number) => ({
    id: id(n),
    name: `t-${String(n).padStart(4, "0")}`,
    kind: n === 1 ? "local" : "ssh"
});
const app = (n: number) => ({
    id: id(n),
    name: `svc-${n}`,
    targetId: TARGET,
    environment: { project: { name: "shop" } }
});

type Query = { where: { AND: Record<string, unknown>[] }; take: number; orderBy: unknown };
const last = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls.at(-1)![0] as Query;

beforeEach(() => {
    targets.mockReset();
    apps.mockReset();
    requireAdmin.mockClear();
    requirePermission.mockClear();
});

describe("listDeployTargetOptionsAction", () => {
    it("lists the caller's active servers under deploy.manage, as creating a tunnel checks", async () => {
        targets.mockResolvedValue([target(1)]);
        const page = await listDeployTargetOptionsAction({});
        expect(requirePermission).toHaveBeenCalledWith("deploy.manage");
        expect(last(targets).where.AND[0]).toEqual({ ownerId: ME, status: "active" });
        expect(page).toEqual({ items: [{ id: id(1), name: "t-0001", local: true }], next: null });
    });

    it("lists relay candidates only behind the admin gate, never the local machine", async () => {
        targets.mockResolvedValue([]);
        await listDeployTargetOptionsAction({ scope: "relay" });
        expect(requireAdmin).toHaveBeenCalled();
        expect(last(targets).where.AND[0]).toEqual({
            status: "active",
            kind: { not: "local" },
            owner: { isAdmin: true }
        });
    });

    it("lists a project owner's servers under read access to the project", async () => {
        targets.mockResolvedValue([]);
        projectAccess.mockResolvedValue({ ownerId: ADMIN });
        const project = "55555555-5555-4555-8555-555555555555";
        await listDeployTargetOptionsAction({ scope: "project", projectId: project });
        expect(requirePermission).toHaveBeenCalledWith("deploy.read");
        expect(projectAccess).toHaveBeenCalledWith(project, ME, "project.read");
        expect(last(targets).where.AND[0]).toEqual({ ownerId: ADMIN });
    });

    it("refuses the project scope without a project, and a project the caller cannot read", async () => {
        expect(await listDeployTargetOptionsAction({ scope: "project" })).toEqual({
            error: "asyncSelect.failed"
        });
        projectAccess.mockRejectedValue(new Error("Project not found"));
        const refused = await listDeployTargetOptionsAction({
            scope: "project",
            projectId: "55555555-5555-4555-8555-555555555555"
        });
        expect(refused).toEqual({ error: "asyncSelect.failed" });
        expect(targets).not.toHaveBeenCalled();
    });

    it("searches in the database and pages by name and id, one row past the page", async () => {
        targets.mockResolvedValue([target(2), target(3), target(4)]);
        const page = await listDeployTargetOptionsAction({ query: " Edge ", limit: 2 });
        const query = last(targets);
        expect(query.take).toBe(3);
        expect(query.orderBy).toEqual([{ name: "asc" }, { id: "asc" }]);
        expect(query.where.AND).toContainEqual({ name: { contains: "Edge", mode: "insensitive" } });
        expect("items" in page && page.items.map((row) => row.id)).toEqual([id(2), id(3)]);
        expect("next" in page && page.next).toBe(encodeServerCursor("t-0003", id(3)));
    });

    it("continues after the cursor and caps the page", async () => {
        targets.mockResolvedValue([]);
        await listDeployTargetOptionsAction({ cursor: encodeServerCursor("t-0003", id(3)) });
        expect(last(targets).where.AND).toContainEqual({
            OR: [{ name: { gt: "t-0003" } }, { name: "t-0003", id: { gt: id(3) } }]
        });
        expect(await listDeployTargetOptionsAction({ limit: 10_000 })).toEqual({
            error: "asyncSelect.failed"
        });
        expect(await listDeployTargetOptionsAction({ scope: "everyone" })).toEqual({
            error: "asyncSelect.failed"
        });
        expect(targets).toHaveBeenCalledTimes(1);
    });
});

describe("listServiceOptionsAction", () => {
    it("lists the caller's services, leaving one server's out, as createTunnel checks", async () => {
        apps.mockResolvedValue([app(1)]);
        const page = await listServiceOptionsAction({ excludeTargetId: TARGET, query: "shop" });
        expect(requirePermission).toHaveBeenCalledWith("deploy.manage");
        const where = last(apps).where.AND;
        expect(where[0]).toEqual({ environment: { project: { ownerId: ME } } });
        expect(where).toContainEqual({ targetId: { not: TARGET } });
        expect(JSON.stringify(where)).toContain('"contains":"shop"');
        expect(page).toEqual({
            items: [{ id: id(1), name: "svc-1", project: "shop", targetId: TARGET }],
            next: null
        });
    });

    it("refuses what it does not know rather than widening the list", async () => {
        expect(await listServiceOptionsAction({ ownerId: ADMIN })).toEqual({
            error: "asyncSelect.failed"
        });
        expect(apps).not.toHaveBeenCalled();
    });
});

describe("template project and environment options", () => {
    it("pages the projects on the open shelf with the environment each lands in", async () => {
        const { templateProjectOptionsAction } =
            await import("@/app/(app)/deploy-target-options-actions");
        projects.mockResolvedValue([
            { id: id(1), name: "a", environments: [{ id: id(11) }, { id: id(12) }] },
            { id: id(2), name: "b", environments: [] }
        ]);
        const page = await templateProjectOptionsAction({ limit: 1 });
        expect(requirePermission).toHaveBeenCalledWith("deploy.manage");
        expect(last(projects).where.AND[0]).toEqual({ OR: [] });
        expect(last(projects).take).toBe(2);
        expect(page).toEqual({
            items: [{ id: id(1), name: "a", environmentId: id(11), manyEnvironments: true }],
            next: encodeServerCursor("a", id(1))
        });
    });

    it("reads one project's environments only through that same shelf", async () => {
        const { templateEnvironmentOptionsAction } =
            await import("@/app/(app)/deploy-target-options-actions");
        environments.mockResolvedValue([{ id: id(11), name: "prod" }]);
        const page = await templateEnvironmentOptionsAction({ projectId: id(1) });
        expect(last(environments).where.AND[0]).toEqual({ projectId: id(1), project: { OR: [] } });
        expect(page).toEqual({ items: [{ id: id(11), name: "prod" }], next: null });
        expect(await templateEnvironmentOptionsAction({})).toEqual({ error: "asyncSelect.failed" });
    });
});
