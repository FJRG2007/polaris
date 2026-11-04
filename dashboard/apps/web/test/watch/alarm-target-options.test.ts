/**
 * What an alarm may watch, a page at a time: the owner's servers with the
 * machine Polaris runs on offered first until it is enrolled, read back by id
 * for a chosen one, and domains continued on their hostname.
 */

import { LOCAL_HOST_SUBJECT } from "@/lib/metrics-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    hosts: [] as { id: string; name: string; dockerId: string | null; address: string | null }[],
    enrolled: null as { id: string } | null,
    calls: [] as unknown[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        host: {
            findMany: vi.fn(async (args: { take: number }) => {
                state.calls.push(args);
                return state.hosts.slice(0, args.take);
            }),
            findFirst: vi.fn(async () => state.enrolled)
        },
        domain: {
            findMany: vi.fn(async (args: { take: number }) => {
                state.calls.push(args);
                return [
                    { id: "00000000-0000-4000-8000-00000000000a", hostname: "a.example.test" },
                    { id: "00000000-0000-4000-8000-00000000000b", hostname: "b.example.test" }
                ].slice(0, args.take);
            })
        },
        application: { findMany: vi.fn(async () => []) },
        ups: { findMany: vi.fn(async () => []) }
    }
}));

vi.mock("@/lib/local-machine", () => ({
    localMachineIdentity: vi.fn(async () => ({
        hostId: null,
        dockerId: "docker-local",
        addresses: new Set<string>()
    })),
    isLocalMachine: (host: { dockerId?: string | null }) => host.dockerId === "docker-local"
}));

vi.mock("@/lib/local-server", () => ({
    getLocalServerName: vi.fn(async () => "this-box"),
    LOCAL_SERVER_FALLBACK_NAME: "This server"
}));

import { decodeServerCursor } from "@/lib/server-options";
import { alarmTargetOptions } from "@/lib/watch/alarm-target-options";

const page = { query: "", cursor: null, limit: 50 };

beforeEach(() => {
    state.hosts = [{ id: "h1", name: "garage", dockerId: null, address: "10.0.0.2" }];
    state.enrolled = null;
    state.calls = [];
});

describe("alarm target options", () => {
    it("offers the machine Polaris runs on first while it is not enrolled", async () => {
        const result = await alarmTargetOptions("owner", "host", page);
        expect(result.items.map((one) => one.id)).toEqual([LOCAL_HOST_SUBJECT, "h1"]);
        expect(result.items[0]).toMatchObject({ name: "this-box", measuresDisk: true });
        expect(result.items[1]?.measuresDisk).toBe(false);
    });

    it("leaves it out once enrolled, after the first page, and when the search misses it", async () => {
        state.enrolled = { id: "h9" };
        expect((await alarmTargetOptions("owner", "host", page)).items).toHaveLength(1);
        state.enrolled = null;
        const later = await alarmTargetOptions("owner", "host", { ...page, cursor: "x" });
        expect(later.items.some((one) => one.id === LOCAL_HOST_SUBJECT)).toBe(false);
        const searched = await alarmTargetOptions("owner", "host", { ...page, query: "gar" });
        expect(searched.items.some((one) => one.id === LOCAL_HOST_SUBJECT)).toBe(false);
    });

    it("names the local subject when it is asked for by id", async () => {
        state.hosts = [];
        const result = await alarmTargetOptions("owner", "host", {
            ...page,
            ids: [LOCAL_HOST_SUBJECT]
        });
        expect(result.items.map((one) => one.id)).toEqual([LOCAL_HOST_SUBJECT]);
    });

    it("pages domains on their hostname and scopes them to the owner", async () => {
        const result = await alarmTargetOptions("owner", "domain", { ...page, limit: 1 });
        expect(result.items).toEqual([
            { id: "00000000-0000-4000-8000-00000000000a", name: "a.example.test" }
        ]);
        expect(decodeServerCursor(result.next)).toEqual({
            name: "a.example.test",
            id: "00000000-0000-4000-8000-00000000000a"
        });
        expect(JSON.stringify(state.calls[0])).toContain('"ownerId":"owner"');
    });
});
