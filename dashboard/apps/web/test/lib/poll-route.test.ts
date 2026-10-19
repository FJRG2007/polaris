import { z } from "zod";
import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ backgroundUser: vi.fn() }));
vi.mock("@/lib/session", () => session);

import { readPoll } from "@/lib/poll-fetch";
import { pollRoute } from "@/lib/poll-route";

const ask = (query = "") => new Request(`http://polaris.test/api/thing${query}`);
const route = (
    read: (input: { id: string }) => Promise<unknown>,
    options?: { signedIn?: boolean }
) => pollRoute(z.object({ id: z.string().uuid() }), read, options);
const ID = "4f0c1c6e-6f0e-4d2a-9a51-2a3f1f6c9d10";

beforeEach(() => {
    session.backgroundUser.mockReset();
    session.backgroundUser.mockResolvedValue({ id: "user-1" });
});

describe("pollRoute", () => {
    it("refuses a caller who is not signed in, without running the read", async () => {
        session.backgroundUser.mockResolvedValue(null);
        const read = vi.fn();
        const response = await route(read)(ask(`?id=${ID}`));
        expect(response.status).toBe(401);
        expect(read).not.toHaveBeenCalled();
    });

    it("lets a public read through when told the caller need not be signed in", async () => {
        session.backgroundUser.mockResolvedValue(null);
        const response = await route(async () => "ok", { signedIn: false })(ask(`?id=${ID}`));
        expect(response.status).toBe(200);
    });

    it("refuses a query that fails its schema", async () => {
        const read = vi.fn();
        const response = await route(read)(ask("?id=not-a-uuid"));
        expect(response.status).toBe(400);
        expect(read).not.toHaveBeenCalled();
    });

    it("answers what the read answers, never cached", async () => {
        const response = await route(async ({ id }) => ({ id, n: 1 }))(ask(`?id=${ID}`));
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({ value: { id: ID, n: 1 } });
    });

    it("turns the action's redirect away into a refusal", async () => {
        const response = await route(async () => redirect("/home?denied=1"))(ask(`?id=${ID}`));
        expect(response.status).toBe(403);
    });

    it("answers a failure without naming it", async () => {
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const response = await route(async () => {
            throw new Error("connection string postgres://secret");
        })(ask(`?id=${ID}`));
        expect(response.status).toBe(500);
        expect(await response.text()).not.toContain("secret");
        quiet.mockRestore();
    });
});

describe("readPoll", () => {
    it("reads back what the route sent, a Date still a Date", async () => {
        const at = new Date("2026-10-19T10:00:00Z");
        const response = await route(async () => ({ at, missing: undefined }))(ask(`?id=${ID}`));
        const fetchMock = vi.fn(async () => response);
        vi.stubGlobal("fetch", fetchMock);
        const value = await readPoll<{ at: Date; missing?: string }>("/api/thing", { id: ID });
        expect(value.at).toBeInstanceOf(Date);
        expect(value.at.getTime()).toBe(at.getTime());
        expect(value.missing).toBeUndefined();
        expect(fetchMock).toHaveBeenCalledWith(`/api/thing?id=${ID}`, {
            cache: "no-store",
            signal: undefined
        });
        vi.unstubAllGlobals();
    });

    it("rejects when the route refuses, as the action it replaces rejected", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("{}", { status: 403 }))
        );
        await expect(readPoll("/api/thing", {})).rejects.toThrow();
        vi.unstubAllGlobals();
    });
});
