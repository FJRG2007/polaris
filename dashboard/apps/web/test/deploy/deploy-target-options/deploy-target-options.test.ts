import { beforeEach, describe, expect, it, vi } from "vitest";

const targets = vi.fn();
const apps = vi.fn();
vi.mock("@polaris/db", () => ({
    prisma: {
        deployTarget: { findMany: (...args: unknown[]) => targets(...args) },
        application: { findMany: (...args: unknown[]) => apps(...args) }
    }
}));
const requireAdmin = vi.fn(async () => ({ id: ADMIN }));
const requirePermission = vi.fn(async () => ({ id: ME }));
vi.mock("@/lib/session", () => ({
    requireAdmin: () => requireAdmin(),
    requirePermission: (permission: string) => requirePermission(permission)
}));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));

const { listDeployTargetOptionsAction, listServiceOptionsAction } = await import(
    "@/app/(app)/deploy-target-options-actions"
);
const { encodeServerCursor } = await import("@/lib/server-options");

const ME = "11111111-1111-4111-8111-111111111111";
const ADMIN = "44444444-4444-4444-8444-444444444444";
const TARGET = "33333333-3333-4333-8333-333333333333";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const target = (n: number) => ({ id: id(n), name: `t-${String(n).padStart(4, "0")}`, kind: n === 1 ? "local" : "ssh" });
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
