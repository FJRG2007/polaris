/**
 * The Code step as the engine runs it.
 *
 * Pinned: it reads the items of the step wired into it (or the list it names),
 * hands back `items`, `count` and the console lines, stores a failure as a code
 * the run view words - with the line where the engine named one - and is
 * refused past each account's runs a minute.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const limiter = vi.hoisted(() => ({ ok: true, keys: [] as string[] }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async (key: string) => {
        limiter.keys.push(key);
        return { ok: limiter.ok, retryAfterMs: 0 };
    }
}));

const { codeNode, asItems } = await import("@/lib/automations/nodes/code-node");
const { StepError } = await import("@/lib/automations/types");

const io = {
    actor: { id: "u1", isAdmin: false },
    runId: "r1",
    automationId: "a1",
    idempotencyKey: "r1:c:0",
    depth: 0,
    since: new Date(),
    leads: () => false,
    shelf: { orgId: null, userId: "u1" },
    timeZone: "UTC",
    signal: new AbortController().signal,
    allowLocalNetwork: false,
    incoming: ["http1"],
    secret: async () => "never",
    recordInput: () => undefined
};
const context = {
    trigger: {},
    steps: { http1: { body: { rows: [{ n: 1 }, { n: 2 }, { n: 3 }] } }, list1: { items: [{ n: 9 }] } },
    run: { id: "r1", startedAt: null, status: null, error: null },
    automation: { id: "a1", name: "A" },
    now: new Date().toISOString()
};

function config(code: string, items = "") {
    return core.CORE_NODE_CONFIGS["core.code"].parse({ code, items });
}

async function failureOf(promise: Promise<unknown>): Promise<InstanceType<typeof StepError>> {
    try {
        await promise;
    } catch (caught) {
        if (caught instanceof StepError) return caught;
        throw caught;
    }
    throw new Error("expected the step to fail");
}

beforeEach(() => {
    limiter.ok = true;
    limiter.keys = [];
});

describe("Code step", () => {
    it("requires code in its config", () => {
        expect(core.CORE_NODE_CONFIGS["core.code"].safeParse({ code: "  " }).success).toBe(false);
        expect(
            core.CORE_NODE_CONFIGS["core.code"].safeParse({ code: "x".repeat(core.AUTOMATION_LIMITS.codeLength + 1) })
                .success
        ).toBe(false);
    });

    it("reads the named list and returns items, count and logs", async () => {
        const result = await codeNode.run!(
            config("console.log(items.length);\nreturn items.filter((item) => item.n > 1);", "{{steps.http1.body.rows}}"),
            context,
            io
        );
        expect(result).toEqual({ output: { items: [{ n: 2 }, { n: 3 }], count: 2, logs: ["3"] } });
        expect(limiter.keys).toEqual(["automation-code:u1"]);
    });

    it("reads the step wired into it when no list is named", async () => {
        const result = await codeNode.run!(config("return items;"), context, { ...io, incoming: ["list1"] });
        expect(result).toEqual({ output: { items: [{ n: 9 }], count: 1, logs: [] } });
        expect(asItems(null)).toEqual([]);
        expect(asItems({ a: 1 })).toEqual([{ a: 1 }]);
    });

    it("stores a thrown error with its line and message", async () => {
        const error = await failureOf(codeNode.run!(config("const a = 1;\nthrow new Error('no rows');"), context, io));
        expect(error.code).toBe("codeRuntime:2");
        expect(error.output).toMatchObject({ error: { line: 2, message: expect.stringContaining("no rows") } });
    });

    it("stores a timeout and an oversized output as their codes", async () => {
        expect((await failureOf(codeNode.run!(config("while (true) {}"), context, io))).code).toBe("codeTimeout");
        expect((await failureOf(codeNode.run!(config("return ['x'.repeat(100000)];"), context, io))).code).toBe(
            "codeOutput"
        );
    }, 20_000);

    it("is refused past the account's runs a minute", async () => {
        limiter.ok = false;
        expect((await failureOf(codeNode.run!(config("return items;"), context, io))).code).toBe("codeLimited");
    });
});
