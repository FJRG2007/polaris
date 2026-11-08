/**
 * The route every Management region reads through after the paint: it answers
 * only the reads it knows, and asks for the operator - or, for an inbox read,
 * whoever answers the inbox - before it runs one.
 */

import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({
    admin: vi.fn(async (): Promise<unknown> => ({ id: "admin-1" })),
    permission: vi.fn(async (_permission: string): Promise<unknown> => ({ id: "agent-1" }))
}));

vi.mock("@/lib/api-session", () => ({
    apiAdmin: gate.admin,
    apiPermission: gate.permission
}));
vi.mock("@/lib/poll-route", () => ({
    pollRoute: (_query: unknown, run: (input: unknown) => Promise<unknown>) => async () =>
        Response.json({ value: await run({}) })
}));
vi.mock("@/app/(app)/admin/paint-reads", () => ({
    PAINT_READS: {
        settings: { query: z.object({}), run: async () => "settings", inbox: false },
        inbox: { query: z.object({}), run: async () => "inbox", inbox: true }
    }
}));

import { GET } from "@/app/api/admin/paint/[read]/route";

function ask(read: string) {
    return GET(new Request(`http://polaris.test/api/admin/paint/${read}`), {
        params: Promise.resolve({ read })
    });
}

beforeEach(() => {
    gate.admin.mockClear();
    gate.permission.mockClear();
});

describe("the after-paint read route", () => {
    it("answers an operator read once the operator is confirmed", async () => {
        const response = await ask("settings");
        expect(await response.json()).toEqual({ value: "settings" });
        expect(gate.admin).toHaveBeenCalledTimes(1);
        expect(gate.permission).not.toHaveBeenCalled();
    });

    it("asks for the inbox permission, not the operator, on an inbox read", async () => {
        const response = await ask("inbox");
        expect(await response.json()).toEqual({ value: "inbox" });
        expect(gate.permission).toHaveBeenCalledWith("inbox.read");
        expect(gate.admin).not.toHaveBeenCalled();
    });

    it("returns the refusal instead of running the read", async () => {
        gate.admin.mockResolvedValueOnce(new Response(null, { status: 403 }));
        expect((await ask("settings")).status).toBe(403);
    });

    it("knows no read it was not given, including inherited names", async () => {
        expect((await ask("nothing")).status).toBe(404);
        expect((await ask("constructor")).status).toBe(404);
        expect(gate.admin).not.toHaveBeenCalled();
    });
});
