/**
 * The Containers host switcher a page at a time: the local engine first (only
 * where it is offered), then stored connections, then registered servers - each
 * by (name, id) in the database - and one host resolved by its id.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const storedFindMany = vi.fn(async (_args: Record<string, unknown>) => [] as unknown[]);
const hostFindMany = vi.fn(async (_args: Record<string, unknown>) => [] as unknown[]);
const hostFindFirst = vi.fn(async (_args: Record<string, unknown>) => null as unknown);

vi.mock("server-only", () => ({}));
vi.mock("@polaris/db", () => ({
    prisma: {
        dockerConnection: {
            findMany: (args: Record<string, unknown>) => storedFindMany(args),
            findFirst: async () => null
        },
        host: {
            findMany: (args: Record<string, unknown>) => hostFindMany(args),
            findFirst: (args: Record<string, unknown>) => hostFindFirst(args)
        }
    }
}));
vi.mock("@/lib/docker-service", () => ({
    HOST_DOCKER_PREFIX: "host:",
    LOCAL_DOCKER_CONNECTION_ID: "local"
}));
vi.mock("@/lib/host-capabilities", () => ({ capabilitiesFor: vi.fn() }));
vi.mock("@/lib/session", () => ({ userHasManage: vi.fn() }));
vi.mock("@/lib/local-machine", () => ({
    localMachineIdentity: vi.fn(),
    isLocalMachine: () => false
}));

const conn = await import("@/app/(app)/apps/containers/connections");

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const user = { id: uid(1) } as never;
const ctx = (localAvailable: boolean, sameMachine: { id: string; name: string } | null = null) => ({
    canManage: localAvailable,
    localAvailable,
    localDiagnostic: null,
    sameMachine
});
const stored = (n: number) => ({ id: uid(n), name: `s${n}`, transport: "tcp", status: "active" });
const server = (n: number) => ({ id: uid(n), name: `h${n}`, status: "online" });

beforeEach(() => {
    storedFindMany.mockReset();
    hostFindMany.mockReset();
    hostFindFirst.mockReset();
});

describe("connectionOptionsPage", () => {
    it("fills a page with local, then stored, then servers, and continues on servers", async () => {
        storedFindMany.mockResolvedValueOnce([stored(10)]);
        hostFindMany.mockResolvedValueOnce([server(20), server(21)]);
        const page = await conn.connectionOptionsPage(
            user,
            ctx(true, { id: uid(30), name: "Home" }),
            conn.connectionOptionsInput.parse({ limit: 3 })
        );
        expect(page.items.map((item) => item.id)).toEqual(["local", uid(10), `host:${uid(20)}`]);
        expect(page.items[0]!.name).toBe("Home");
        expect(storedFindMany.mock.calls[0]![0].take).toBe(3);
        const hostArgs = hostFindMany.mock.calls[0]![0] as { take: number; where: { id: unknown } };
        expect(hostArgs.take).toBe(2);
        // The registered server that is the local engine is not offered twice.
        expect(hostArgs.where.id).toEqual({ not: uid(30) });
        expect(page.next).not.toBeNull();

        hostFindMany.mockResolvedValueOnce([server(21)]);
        const second = await conn.connectionOptionsPage(
            user,
            ctx(true, { id: uid(30), name: "Home" }),
            conn.connectionOptionsInput.parse({ limit: 3, cursor: page.next })
        );
        expect(storedFindMany).toHaveBeenCalledTimes(1);
        const after = hostFindMany.mock.calls[1]![0] as { where: { AND: unknown[] } };
        expect(after.where.AND).toEqual([
            { OR: [{ name: { gt: "h20" } }, { name: "h20", id: { gt: uid(20) } }] }
        ]);
        expect(second).toEqual({ items: [expect.objectContaining({ hostId: uid(21) })], next: null });
    });

    it("stops inside the stored connections when they fill the page", async () => {
        storedFindMany.mockResolvedValueOnce([stored(10), stored(11), stored(12)]);
        const page = await conn.connectionOptionsPage(
            user,
            ctx(false),
            conn.connectionOptionsInput.parse({ limit: 2, query: "s" })
        );
        expect(page.items.map((item) => item.id)).toEqual([uid(10), uid(11)]);
        expect(hostFindMany).not.toHaveBeenCalled();
        const args = storedFindMany.mock.calls[0]![0] as { where: { AND: unknown[] } };
        expect(args.where.AND).toEqual([{ name: { contains: "s", mode: "insensitive" } }]);
        expect(page.next).not.toBeNull();
    });
});

describe("resolveConnection", () => {
    it("never offers the local engine to somebody it is not offered to", async () => {
        expect(await conn.resolveConnection(user, ctx(false), "local")).toBeNull();
        expect((await conn.resolveConnection(user, ctx(true), "local"))?.local).toBe(true);
    });

    it("reads one server by id, the reader's own only", async () => {
        hostFindFirst.mockResolvedValueOnce(server(20));
        const found = await conn.resolveConnection(user, ctx(false), `host:${uid(20)}`);
        expect(found?.hostId).toBe(uid(20));
        expect(hostFindFirst.mock.calls[0]![0].where).toEqual({ id: uid(20), ownerId: uid(1) });
        expect(await conn.resolveConnection(user, ctx(false), "host:not-a-uuid")).toBeNull();
    });
});
