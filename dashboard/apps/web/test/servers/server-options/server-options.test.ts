import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const sessionCan = vi.fn(async (..._args: unknown[]) => true);
vi.mock("@polaris/db", () => ({
    prisma: { host: { findMany: (...args: unknown[]) => findMany(...args) } }
}));
vi.mock("@/lib/session", () => ({
    requireUser: vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111" })),
    requirePermission: vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111" })),
    sessionCan: (...args: unknown[]) => sessionCan(...args)
}));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/local-server", () => ({ localServerName: async () => "This machine" }));
const requireEnvironmentAccess = vi.fn();
vi.mock("@/lib/deploy-project-access", () => ({
    requireEnvironmentAccess: (...args: unknown[]) => requireEnvironmentAccess(...args)
}));

const { listServerOptionsAction } = await import("@/app/(app)/server-options-actions");
const { encodeServerCursor, findLocalHost } = await import("@/lib/server-options");
const { SERVER_OPTIONS_MAX_PAGE, SERVER_OPTIONS_PAGE } =
    await import("@/lib/server-options-schema");

const ME = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const ENV = "33333333-3333-4333-8333-333333333333";

function host(n: number) {
    return {
        id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
        name: `srv-${String(n).padStart(4, "0")}`,
        address: `10.0.0.${n}`,
        os: null,
        environment: "vps",
        sudo: false,
        username: "polaris",
        status: "active",
        offlineSince: null
    };
}

type Where = { AND: Record<string, unknown>[] };
const lastQuery = () =>
    findMany.mock.calls.at(-1)![0] as { where: Where; take: number; orderBy: unknown };

beforeEach(() => {
    findMany.mockReset();
    requireEnvironmentAccess.mockReset();
    sessionCan.mockReset();
    sessionCan.mockResolvedValue(true);
});

describe("listServerOptionsAction", () => {
    it("lists only the caller's own servers, the scope using a server checks", async () => {
        findMany.mockResolvedValue([host(1)]);
        await listServerOptionsAction({});
        expect(lastQuery().where.AND[0]).toEqual({ ownerId: ME });
    });

    it("reads a project's servers as its owner's, behind the project read grant", async () => {
        requireEnvironmentAccess.mockResolvedValue({ ownerId: OWNER });
        findMany.mockResolvedValue([]);
        await listServerOptionsAction({ environmentId: ENV });
        expect(requireEnvironmentAccess).toHaveBeenCalledWith(ENV, ME, "project.read");
        expect(lastQuery().where.AND[0]).toEqual({ ownerId: OWNER });
    });

    it("answers a refused project with the generic failure, never somebody's servers", async () => {
        requireEnvironmentAccess.mockRejectedValue(new Error("Project not found"));
        const answer = await listServerOptionsAction({ environmentId: ENV });
        expect(answer).toEqual({ error: "asyncSelect.failed" });
        expect(findMany).not.toHaveBeenCalled();
    });

    it("searches name and address in the database, case-insensitively", async () => {
        findMany.mockResolvedValue([]);
        await listServerOptionsAction({ query: "  Edge " });
        expect(lastQuery().where.AND).toContainEqual({
            OR: [
                { name: { contains: "Edge", mode: "insensitive" } },
                { address: { contains: "Edge", mode: "insensitive" } }
            ]
        });
    });

    it("applies a screen's filters in the query", async () => {
        findMany.mockResolvedValue([]);
        const other = host(9).id;
        await listServerOptionsAction({
            filter: { root: true, withoutVpnNode: true, exclude: [other] }
        });
        const and = lastQuery().where.AND;
        expect(and).toContainEqual({ OR: [{ sudo: true }, { username: "root" }] });
        expect(and).toContainEqual({ vpnNode: { is: null } });
        expect(and).toContainEqual({ id: { notIn: [other] } });
    });

    it("pages by name and id, reading one past the page to know there is more", async () => {
        findMany.mockResolvedValue(
            Array.from({ length: SERVER_OPTIONS_PAGE + 1 }, (_, n) => host(n + 1))
        );
        const page = await listServerOptionsAction({});
        if ("error" in page) throw new Error(page.error);
        expect(lastQuery().take).toBe(SERVER_OPTIONS_PAGE + 1);
        expect(lastQuery().orderBy).toEqual([{ name: "asc" }, { id: "asc" }]);
        expect(page.items).toHaveLength(SERVER_OPTIONS_PAGE);
        const last = host(SERVER_OPTIONS_PAGE);
        expect(page.next).toBe(encodeServerCursor(last.name, last.id));

        findMany.mockResolvedValue([host(99)]);
        const second = await listServerOptionsAction({ cursor: page.next });
        expect(lastQuery().where.AND).toContainEqual({
            OR: [{ name: { gt: last.name } }, { name: last.name, id: { gt: last.id } }]
        });
        if ("error" in second) throw new Error(second.error);
        expect(second.next).toBeNull();
    });

    it("pages on past the longest name a server may have, in any script", async () => {
        const longest = [
            "\u{1F5A5}".repeat(120),
            "端".repeat(120),
            "\u0001".repeat(120),
            "\\".repeat(120)
        ];
        for (const name of longest) {
            const last = { ...host(1), name };
            findMany.mockResolvedValue([last]);
            const result = await listServerOptionsAction({
                cursor: encodeServerCursor(name, last.id)
            });
            expect(result).not.toHaveProperty("error");
            expect(lastQuery().where.AND).toContainEqual({
                OR: [{ name: { gt: name } }, { name, id: { gt: last.id } }]
            });
        }
    });

    it("lists nothing for somebody with no server tool to pick for", async () => {
        sessionCan.mockResolvedValue(false);
        const result = await listServerOptionsAction({});
        expect(result).toEqual({ error: "asyncSelect.failed" });
        expect(findMany).not.toHaveBeenCalled();
        expect(sessionCan.mock.calls.map(([, permission]) => permission)).toEqual([
            "deploy.read",
            "system.manage"
        ]);
    });

    it("treats a hand-made cursor as the top rather than an error", async () => {
        findMany.mockResolvedValue([]);
        await listServerOptionsAction({ cursor: "not-a-cursor" });
        expect(lastQuery().where.AND.some((part) => "OR" in part)).toBe(false);
    });

    it("refuses a page larger than the cap and anything it does not know", async () => {
        expect(await listServerOptionsAction({ limit: SERVER_OPTIONS_MAX_PAGE + 1 })).toEqual({
            error: "asyncSelect.failed"
        });
        expect(await listServerOptionsAction({ filter: { owner: ME } })).toEqual({
            error: "asyncSelect.failed"
        });
        expect(await listServerOptionsAction({ ids: ["../etc"] })).toEqual({
            error: "asyncSelect.failed"
        });
        expect(findMany).not.toHaveBeenCalled();
    });

    it("offers the machine Polaris runs on first, on the first page only", async () => {
        findMany.mockResolvedValue([host(1)]);
        const first = await listServerOptionsAction({ includeLocal: true });
        if ("error" in first) throw new Error(first.error);
        expect(first.items.map(({ id }) => id)).toEqual(["local", host(1).id]);

        const later = await listServerOptionsAction({
            includeLocal: true,
            cursor: encodeServerCursor("srv-0001", host(1).id)
        });
        if ("error" in later) throw new Error(later.error);
        expect(later.items.map(({ id }) => id)).toEqual([host(1).id]);
    });

    it("names a chosen server by id without listing the rest", async () => {
        findMany.mockResolvedValue([host(5)]);
        await listServerOptionsAction({ ids: [host(5).id] });
        expect(lastQuery().where.AND).toContainEqual({ id: { in: [host(5).id] } });
    });
});

describe("findLocalHost", () => {
    const identity = (hostId: string | null, dockerId: string | null, addresses: string[]) => ({
        hostId,
        dockerId,
        addresses: new Set(addresses)
    });

    it("asks once, bounded, for any of the three signals, inside the owner's servers", async () => {
        findMany.mockResolvedValue([]);
        await findLocalHost(ME, identity("h1", "d1", ["127.0.0.1", "192.168.1.5"]));
        expect(findMany).toHaveBeenCalledTimes(1);
        const query = findMany.mock.calls[0]![0] as { where: unknown; take: number };
        expect(query.take).toBeLessThanOrEqual(3);
        expect(query.where).toEqual({
            ownerId: ME,
            OR: [
                { id: "h1" },
                { dockerId: "d1" },
                { address: { in: ["127.0.0.1", "192.168.1.5"], mode: "insensitive" } }
            ]
        });
    });

    it("prefers the enrollment's own row when several match", async () => {
        findMany.mockResolvedValue([
            { id: "a", name: "a", address: "127.0.0.1", dockerId: null },
            { id: "h1", name: "z", address: "x", dockerId: null }
        ]);
        expect((await findLocalHost(ME, identity("h1", null, ["127.0.0.1"])))?.id).toBe("h1");
    });

    it("reads nothing when there is no signal at all", async () => {
        expect(await findLocalHost(ME, identity(null, null, []))).toBeNull();
        expect(findMany).not.toHaveBeenCalled();
    });
});
