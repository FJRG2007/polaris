/**
 * A server that stops answering is reported with the moment it stopped, kept on
 * the row so it survives a restart, and cleared once it answers again. Written
 * on a change only: a poll that finds nothing new writes nothing.
 */

import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface HostRow {
    id: string;
    address: string;
    port: number;
    offlineSince: Date | null;
}

let hosts: HostRow[] = [];
const writes = vi.fn(
    async (args: {
        where: { id: string; offlineSince: unknown };
        data: { offlineSince: Date | null };
    }) => {
        const row = hosts.find((host) => host.id === args.where.id);
        if (!row) return { count: 0 };
        const wantsNull = args.where.offlineSince === null;
        if (wantsNull !== (row.offlineSince === null)) return { count: 0 };
        row.offlineSince = args.data.offlineSince;
        return { count: 1 };
    }
);

vi.mock("@polaris/db", () => ({
    prisma: {
        host: {
            findMany: async () => hosts.map((host) => ({ ...host })),
            updateMany: (args: never) => writes(args as never)
        }
    }
}));

// The real module reaches the auth stack; only its id is needed here.
vi.mock("../../src/lib/local-server", () => ({ LOCAL_SERVER_ID: "local" }));

const { serverStatuses } = await import("../../src/lib/server-status");

let server: Server;
let port = 0;

beforeAll(async () => {
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    hosts = [];
    writes.mockClear();
});

describe("serverStatuses down since", () => {
    it("starts the clock on a server that stopped answering and reports it", async () => {
        hosts = [{ id: "nas", address: "127.0.0.1", port: 1, offlineSince: null }];
        const [, nas] = await serverStatuses("owner");
        expect(nas!.state).toBe("down");
        expect(nas!.downSince).not.toBeNull();
        expect(hosts[0]!.offlineSince).toBeInstanceOf(Date);
        expect(nas!.downSince).toBe(hosts[0]!.offlineSince!.toISOString());
    });

    it("keeps the first moment on later polls and writes nothing", async () => {
        const since = new Date("2026-10-26T08:00:00.000Z");
        hosts = [{ id: "nas", address: "127.0.0.1", port: 1, offlineSince: since }];
        const [, nas] = await serverStatuses("owner");
        expect(nas!.downSince).toBe(since.toISOString());
        expect(writes).not.toHaveBeenCalled();
    });

    it("clears it when the server answers again", async () => {
        hosts = [{ id: "box", address: "127.0.0.1", port, offlineSince: new Date() }];
        const [local, box] = await serverStatuses("owner");
        expect(local!.downSince).toBeNull();
        expect(box!.state).toBe("up");
        expect(box!.downSince).toBeNull();
        expect(hosts[0]!.offlineSince).toBeNull();
    });

    it("writes nothing for a server that was and is up", async () => {
        hosts = [{ id: "box", address: "127.0.0.1", port, offlineSince: null }];
        await serverStatuses("owner");
        expect(writes).not.toHaveBeenCalled();
    });
});
