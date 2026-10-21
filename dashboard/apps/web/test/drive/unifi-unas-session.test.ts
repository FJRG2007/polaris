import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("undici", () => ({
    Agent: class {},
    WebSocket: class {},
    fetch: (...args: unknown[]) => fetchMock(...args)
}));

const control = await import("@/lib/unifi-unas-control");

function login(token: string, csrf = "csrf-1"): Response {
    return new Response("{}", {
        status: 200,
        headers: { "set-cookie": `TOKEN=${token}; Path=/`, "x-csrf-token": csrf }
    });
}
function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
}
function urls(): string[] {
    return fetchMock.mock.calls.map((call) => String(call[0]));
}

let host = 0;
function target() {
    host += 1;
    return { host: `nas-${host}.test`, username: "admin", password: "secret" };
}

describe("unifi-unas-control console session", () => {
    beforeEach(() => fetchMock.mockReset());

    it("signs in once and reuses the session for later calls", async () => {
        const nas = target();
        fetchMock
            .mockResolvedValueOnce(login("one"))
            .mockResolvedValueOnce(json({ profile: "quiet" }))
            .mockResolvedValueOnce(json({ data: [] }))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));
        expect(await control.readFanProfile(nas)).toBe("quiet");
        expect(await control.listBackupTasks(nas)).toEqual([]);
        await control.writeFanProfile(nas, "balanced");
        expect(urls().filter((url) => url.endsWith("/api/auth/login"))).toHaveLength(1);
        const write = fetchMock.mock.calls[3]![1] as {
            headers: Record<string, string>;
            body: string;
        };
        expect(write.headers.cookie).toBe("TOKEN=one");
        expect(write.headers["x-csrf-token"]).toBe("csrf-1");
        expect(JSON.parse(write.body)).toEqual({ profile: "default" });
    });

    it("signs in again once when the console drops the session", async () => {
        const nas = target();
        fetchMock
            .mockResolvedValueOnce(login("old"))
            .mockResolvedValueOnce(json({ profile: "quiet" }))
            .mockResolvedValueOnce(json({}, 401))
            .mockResolvedValueOnce(login("new"))
            .mockResolvedValueOnce(json({ profile: "cooling" }));
        await control.readFanProfile(nas);
        expect(await control.readFanProfile(nas)).toBe("cooling");
        const retried = fetchMock.mock.calls[4]![1] as { headers: Record<string, string> };
        expect(retried.headers.cookie).toBe("TOKEN=new");
    });

    it("gives up after one fresh sign-in is refused too", async () => {
        const nas = target();
        fetchMock
            .mockResolvedValueOnce(login("a"))
            .mockResolvedValueOnce(json({}, 403))
            .mockResolvedValueOnce(login("b"))
            .mockResolvedValueOnce(json({}, 403));
        await expect(control.runBackupTask(nas, "t 1")).rejects.toThrow("failed (403)");
        expect(urls()[1]).toContain("/run-task/t%201");
    });

    it("keeps the LOCAL account hint when the console refuses the sign-in", async () => {
        fetchMock.mockResolvedValueOnce(json({}, 401));
        await expect(control.readFanProfile(target())).rejects.toThrow("LOCAL console account");
    });
});
