import { beforeEach, describe, expect, it, vi } from "vitest";

const hosts = vi.fn();
const groups = vi.fn();
const projects = vi.fn();
const environments = vi.fn();
const apps = vi.fn();
const installs = vi.fn();
vi.mock("@polaris/db", () => ({
    prisma: {
        host: { findMany: (...args: unknown[]) => hosts(...args) },
        hostGroup: { findMany: (...args: unknown[]) => groups(...args) },
        project: { findMany: (...args: unknown[]) => projects(...args) },
        environment: { findMany: (...args: unknown[]) => environments(...args) },
        application: { findMany: (...args: unknown[]) => apps(...args) },
        installedApp: { findMany: (...args: unknown[]) => installs(...args) }
    }
}));
const VISIBLE = { OR: [{ ownerId: "me" }] };
vi.mock("@/lib/deploy-service", () => ({ visibleProjectWhere: async () => VISIBLE }));
vi.mock("@/lib/apps/install-service", () => ({
    installedAppScopeLabel: (name: string, catalogId: string) => `${name} (${catalogId})`
}));

const options = await import("@/lib/firewall-scope-options");
const { encodeServerCursor } = await import("@/lib/server-options");

const ME = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const first = { query: "", cursor: null, limit: 2 };
type Query = { where: { AND: Record<string, unknown>[] }; take: number };
const last = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls.at(-1)![0] as Query;

beforeEach(() => {
    for (const mock of [hosts, groups, projects, environments, apps, installs]) mock.mockReset();
});

describe("readFirewallScopeOptions", () => {
    it("pages the caller's own servers by name, one row past the page", async () => {
        hosts.mockResolvedValue([1, 2, 3].map((n) => ({ id: id(n), name: `h${n}` })));
        const page = await options.readFirewallScopeOptions(ME, "server", first);
        expect(last(hosts).where.AND[0]).toEqual({ ownerId: ME });
        expect(last(hosts).take).toBe(3);
        expect(page.items.map((item) => item.id)).toEqual([id(1), id(2)]);
        expect(page.next).toBe(encodeServerCursor("h2", id(2)));
    });

    it("reads projects, environments and services through the visibility the page used", async () => {
        projects.mockResolvedValue([]);
        environments.mockResolvedValue([{ id: id(1), name: "prod", project: { name: "shop" } }]);
        apps.mockResolvedValue([
            { id: id(2), name: "web", environment: { name: "prod", project: { name: "shop" } } }
        ]);
        await options.readFirewallScopeOptions(ME, "project", first);
        expect(last(projects).where.AND[0]).toBe(VISIBLE);
        const envs = await options.readFirewallScopeOptions(ME, "environment", {
            ...first,
            query: "sh"
        });
        expect(last(environments).where.AND[0]).toEqual({ project: VISIBLE });
        expect(last(environments).where.AND[1]).toHaveProperty("OR");
        expect(envs.items).toEqual([{ id: id(1), name: "prod", path: "shop" }]);
        const services = await options.readFirewallScopeOptions(ME, "application", first);
        expect(last(apps).where.AND[0]).toEqual({
            binnedAt: null,
            environment: { project: VISIBLE }
        });
        expect(services.items[0]).toEqual({ id: id(2), name: "web", path: "shop / prod" });
    });

    it("drops an install whose service the caller cannot see, keyed by the service", async () => {
        installs.mockResolvedValue([
            { id: id(1), name: "mc", catalogId: "minecraft", applicationId: id(11) },
            { id: id(2), name: "other", catalogId: "minecraft", applicationId: id(12) },
            { id: id(3), name: "zz", catalogId: "minecraft", applicationId: id(13) }
        ]);
        apps.mockResolvedValue([{ id: id(11) }]);
        const page = await options.readFirewallScopeOptions(ME, "marketplace", first);
        expect(page.items).toEqual([{ id: id(11), name: "mc (minecraft)", path: null }]);
        // The cursor moves past the dropped row, so the next page does not repeat it.
        expect(page.next).toBe(encodeServerCursor("other", id(2)));
        expect(last(installs).where.AND[0]).toMatchObject({ ownerId: ME });
    });
});

describe("resolveFirewallScope", () => {
    it("refuses a target that is not the caller's instead of falling back", async () => {
        groups.mockResolvedValue([]);
        expect(await options.resolveFirewallScope(ME, "server-group", id(9))).toEqual({
            option: null,
            refused: true
        });
        expect(last(groups).where.AND[1]).toEqual({ id: { in: [id(9)] } });
        expect(await options.resolveFirewallScope(ME, "server-group", "not-an-id")).toEqual({
            option: null,
            refused: true
        });
    });

    it("lands on the first target when the link names none", async () => {
        hosts.mockResolvedValue([{ id: id(1), name: "a" }]);
        const resolved = await options.resolveFirewallScope(ME, "server", undefined);
        expect(resolved).toEqual({ option: { id: id(1), name: "a", path: null }, refused: false });
    });
});
