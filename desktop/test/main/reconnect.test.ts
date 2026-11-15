import { probeServer } from "@/shared/server-identity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReconnector, reconnectDelay, RECONNECT_DELAYS_MS } from "@/main/reconnect";
import { describeNetError, describeOfflinePage, errorText, netErrorCode, RECONNECTS_WORDS } from "@/main/reachability";

const ORIGIN = "https://polaris.example.com";

function json(body: unknown, status = 200, url = `${ORIGIN}/api/polaris/identity`): Response {
    const response = new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    Object.defineProperty(response, "url", { value: url });
    return response;
}

/** A server that refuses `down` asks, the way a restarting one does, then answers. */
function restarting(down: number) {
    let asked = 0;
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => {
        asked += 1;
        if (asked <= down) throw new TypeError("fetch failed", { cause: new Error("net::ERR_CONNECTION_REFUSED") });
        return json({ product: "polaris", protocol: 1 });
    });
    return fetch;
}

/** Let pending promise callbacks run. */
async function settle(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("the reconnect backoff", () => {
    it("starts quick and settles at once a minute", () => {
        expect(reconnectDelay(0)).toBe(2_000);
        expect(reconnectDelay(1)).toBe(4_000);
        expect(reconnectDelay(99)).toBe(60_000);
        expect(reconnectDelay(-1)).toBe(2_000);
        expect([...RECONNECT_DELAYS_MS].sort((a, b) => a - b)).toEqual([...RECONNECT_DELAYS_MS]);
    });
});

describe("createReconnector", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("puts Polaris back by itself once a restarting server answers", async () => {
        const fetch = restarting(2);
        const back = vi.fn();
        const reconnector = createReconnector({
            answers: async () => (await probeServer(ORIGIN, undefined, fetch)).kind === "polaris",
            back
        });
        reconnector.start();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(back).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(4_000);
        expect(back).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(8_000);
        expect(back).toHaveBeenCalledTimes(1);
        expect(reconnector.active).toBe(false);
        // Nothing keeps asking after it is back.
        await vi.advanceTimersByTimeAsync(120_000);
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("never lets one failed check stick", async () => {
        let up = false;
        const back = vi.fn();
        const reconnector = createReconnector({ answers: async () => up, back });
        reconnector.start();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(back).not.toHaveBeenCalled();
        up = true;
        await vi.advanceTimersByTimeAsync(4_000);
        expect(back).toHaveBeenCalledTimes(1);
    });

    it("counts a thrown check as not yet, and keeps asking", async () => {
        let calls = 0;
        const back = vi.fn();
        const reconnector = createReconnector({
            answers: async () => {
                calls += 1;
                if (calls === 1) throw new Error("boom");
                return true;
            },
            back
        });
        reconnector.start();
        await vi.advanceTimersByTimeAsync(2_000 + 4_000);
        expect(back).toHaveBeenCalledTimes(1);
    });

    it("asks at once on a nudge and starts the backoff over", async () => {
        let up = false;
        const answers = vi.fn(async () => up);
        const back = vi.fn();
        const reconnector = createReconnector({ answers, back });
        reconnector.start();
        await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000);
        expect(answers).toHaveBeenCalledTimes(3);
        up = true;
        reconnector.nudge();
        await settle();
        expect(back).toHaveBeenCalledTimes(1);
    });

    it("does nothing on a nudge while stopped", async () => {
        const answers = vi.fn(async () => true);
        const back = vi.fn();
        createReconnector({ answers, back }).nudge();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(answers).not.toHaveBeenCalled();
        expect(back).not.toHaveBeenCalled();
    });

    it("drops an answer that arrives after it was stopped", async () => {
        let release: (value: boolean) => void = () => undefined;
        const back = vi.fn();
        const reconnector = createReconnector({ answers: () => new Promise<boolean>((resolve) => (release = resolve)), back });
        reconnector.start();
        await vi.advanceTimersByTimeAsync(2_000);
        reconnector.stop();
        release(true);
        await settle();
        expect(back).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(back).not.toHaveBeenCalled();
    });

    it("starts once however often it is started", async () => {
        const answers = vi.fn(async () => false);
        const reconnector = createReconnector({ answers, back: vi.fn() });
        reconnector.start();
        reconnector.start();
        reconnector.start();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(answers).toHaveBeenCalledTimes(1);
    });
});

describe("what the window says while the server is restarting", () => {
    it("says restarting and that it reconnects, not that the address is wrong", () => {
        const words = describeOfflinePage("polaris.example.com");
        expect(words).toContain("restarting");
        expect(words).toContain(RECONNECTS_WORDS);
        expect(words).not.toMatch(/Could not reach|typo|Check the address/);
    });
});

describe("a failed main-process request keeps its reason", () => {
    it("reads Chromium's code off a wrapped error's cause", () => {
        const caught = new TypeError("fetch failed", { cause: new Error("net::ERR_CONNECTION_REFUSED") });
        expect(netErrorCode(String(caught))).toBeNull();
        expect(netErrorCode(errorText(caught))).toBe("ERR_CONNECTION_REFUSED");
        expect(describeNetError(netErrorCode(errorText(caught)), "polaris.example.com")).toContain("restarting");
    });

    it("keeps an error's own code and survives odd throws", () => {
        expect(errorText(Object.assign(new Error("x"), { code: "ERR_TIMED_OUT" }))).toContain("ERR_TIMED_OUT");
        expect(errorText("plain")).toBe("plain");
        expect(errorText(null)).toBe("");
        const loop: { cause?: unknown; } = {};
        loop.cause = loop;
        expect(() => errorText(loop)).not.toThrow();
    });

    it("gives the server check a cause it can name when the fetch wraps the error", async () => {
        const fetch = restarting(1);
        const wrapped = (input: string, init?: RequestInit) =>
            fetch(input, init).catch((caught: unknown) => {
                throw new Error(errorText(caught));
            });
        const verdict = await probeServer(ORIGIN, undefined, wrapped);
        expect(verdict.kind).toBe("unreachable");
        expect(verdict.kind === "unreachable" && netErrorCode(verdict.cause ?? "")).toBe("ERR_CONNECTION_REFUSED");
        // The very next ask, once the server is up, is a Polaris: nothing was held.
        expect((await probeServer(ORIGIN, undefined, wrapped)).kind).toBe("polaris");
    });
});
