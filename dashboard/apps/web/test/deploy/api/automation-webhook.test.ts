/**
 * The automation webhook answers its own address and nothing else.
 *
 * A wrong secret reads exactly like an unknown rule, a guesser is cut off after
 * a bounded number of misses, a rule called in a loop is held to a few runs a
 * minute, and a rule whose maker lost the project answers 403 instead of
 * deploying for them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const RULE = "00000000-0000-4000-8000-0000000000b1";
const TOKEN = "a".repeat(43);

const automationForWebhook = vi.fn();
const fireAutomationWebhook = vi.fn();
let counts = new Map<string, number>();

vi.mock("@/lib/deploy/automations", () => ({
    automationForWebhook: (...args: unknown[]) => automationForWebhook(...args),
    fireAutomationWebhook: (...args: unknown[]) => fireAutomationWebhook(...args)
}));
vi.mock("@/lib/request-context", () => ({ clientIp: async () => "203.0.113.7" }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async (key: string, limit: number) => {
        const used = (counts.get(key) ?? 0) + 1;
        counts.set(key, used);
        return used > limit ? { ok: false, retryAfterMs: 30_000 } : { ok: true, retryAfterMs: 0 };
    }
}));

const { POST } = await import("@/app/api/deploy/automations/[id]/[token]/route");

function call(token = TOKEN) {
    return POST(new Request(`https://polaris.example/api/deploy/automations/${RULE}/${token}`, { method: "POST" }), {
        params: Promise.resolve({ id: RULE, token })
    });
}

beforeEach(() => {
    counts = new Map();
    automationForWebhook.mockReset().mockImplementation(async (id: string, token: string) =>
        token === TOKEN ? { id, enabled: true } : null
    );
    fireAutomationWebhook.mockReset().mockResolvedValue({ runId: "run-1" });
});

describe("the automation webhook", () => {
    it("starts the rule for the right address", async () => {
        const response = await call();
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ runId: "run-1" });
        expect(fireAutomationWebhook).toHaveBeenCalledWith(RULE);
    });

    it("answers a wrong secret as an unknown rule, and starts nothing", async () => {
        const response = await call("b".repeat(43));
        expect(response.status).toBe(404);
        expect(fireAutomationWebhook).not.toHaveBeenCalled();
    });

    it("cuts a caller off after too many wrong addresses", async () => {
        let last = 0;
        for (let attempt = 0; attempt < 61; attempt += 1) last = (await call("b".repeat(43))).status;
        expect(last).toBe(429);
    });

    it("still answers the right address to a caller that has missed before", async () => {
        for (let attempt = 0; attempt < 61; attempt += 1) await call("b".repeat(43));
        expect((await call()).status).toBe(202);
    });

    it("holds one rule to a few runs a minute", async () => {
        const statuses: number[] = [];
        for (let attempt = 0; attempt < 7; attempt += 1) statuses.push((await call()).status);
        expect(statuses.slice(0, 6).every((status) => status === 202)).toBe(true);
        expect(statuses[6]).toBe(429);
        expect(fireAutomationWebhook).toHaveBeenCalledTimes(6);
    });

    it("refuses once the rule's maker may no longer deploy the project", async () => {
        fireAutomationWebhook.mockResolvedValue({ refused: "creator" });
        expect((await call()).status).toBe(403);
    });

    it("says a switched-off rule or a run still going is a conflict", async () => {
        fireAutomationWebhook.mockResolvedValue({ refused: "disabled" });
        expect((await call()).status).toBe(409);
        fireAutomationWebhook.mockResolvedValue({ refused: "busy" });
        expect((await call()).status).toBe(409);
    });
});
