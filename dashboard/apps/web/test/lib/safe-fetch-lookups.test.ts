/**
 * Outside name lookups never take the whole thread pool.
 *
 * A cold Mail list asked for a sender's mark per row, each a handful of lookups,
 * and with nothing bounding them every libuv thread sat on a slow resolver -
 * which stalled cookie checks and compression for every page in Polaris. From
 * the browser that was a click on another app that did nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dns = vi.hoisted(() => ({
    calls: [] as string[],
    running: 0,
    peak: 0,
    pending: [] as Array<() => void>
}));

vi.mock("undici", () => ({ Agent: class {}, fetch: async () => new Response(null) }));

vi.mock("node:dns/promises", () => ({
    lookup: async (hostname: string) => {
        dns.calls.push(hostname);
        dns.running += 1;
        dns.peak = Math.max(dns.peak, dns.running);
        await new Promise<void>((resolve) => dns.pending.push(resolve));
        dns.running -= 1;
        return [{ address: "93.184.216.34", family: 4 }];
    }
}));

const { resolveName, reachable } = await import("@/lib/safe-fetch");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function drain(): Promise<void> {
    while (dns.pending.length > 0 || dns.running > 0) {
        dns.pending.splice(0).forEach((resolve) => resolve());
        await tick();
    }
}

beforeEach(() => {
    dns.calls = [];
    dns.running = 0;
    dns.peak = 0;
    dns.pending = [];
});

describe("resolveName", () => {
    it("runs at most two lookups at once, however many are asked for", async () => {
        const names = Array.from({ length: 12 }, (_, index) => `host${index}.example`);
        const answers = Promise.all(names.map((name) => reachable(name)));
        await tick();
        expect(dns.running).toBe(2);
        await drain();
        await expect(answers).resolves.toEqual(names.map(() => true));
        expect(dns.peak).toBe(2);
        expect(dns.calls).toHaveLength(12);
    });

    it("asks once for a name requested many times together", async () => {
        const answers = Promise.all(Array.from({ length: 20 }, () => resolveName("Shop.example")));
        await tick();
        await drain();
        const resolved = await answers;
        expect(dns.calls).toEqual(["Shop.example"]);
        expect(resolved.every((entry) => entry[0]?.address === "93.184.216.34")).toBe(true);
    });

    it("gives up waiting on a lookup that never answers", async () => {
        vi.useFakeTimers();
        try {
            const answer = resolveName("silent.example");
            const settled = expect(answer).rejects.toThrow("took too long");
            await vi.advanceTimersByTimeAsync(5001);
            await settled;
        } finally {
            vi.useRealTimers();
            await drain();
        }
    });
});
