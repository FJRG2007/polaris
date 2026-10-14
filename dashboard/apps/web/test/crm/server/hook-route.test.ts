/**
 * A workflow's webhook address: a body past the limit is refused without being
 * read to its end, and a caller is told whether the run went through, never why
 * it did not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    runHook: vi.fn(async (): Promise<unknown> => ({ error: null }))
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        requestContext: { clientIp: async () => "203.0.113.7" },
        rateLimitService: { rateLimit: async () => ({ ok: true }) }
    }
}));
vi.mock("@polaris-app/crm/src/lib/workflows", () => ({
    hookHash: () => "hash",
    runHook: mocks.runHook
}));

import { MAX_HOOK_BODY } from "@polaris-app/crm/src/model/workflows";
import { POST } from "@polaris-app/crm/src/routes/api/crm/hooks/[secret]/route";

const SECRET = "A".repeat(32);
const params = { params: Promise.resolve({ secret: SECRET }) };

beforeEach(() => vi.clearAllMocks());

describe("webhook route", () => {
    it("refuses a chunked body past the limit, reading no further than it", async () => {
        let pulled = 0;
        const chunk = new Uint8Array(64 * 1024);
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled += 1;
                if (pulled > 10_000) controller.close();
                else controller.enqueue(chunk);
            }
        });
        const request = new Request("http://localhost/api/crm/hooks/x", {
            method: "POST",
            body,
            duplex: "half"
        } as RequestInit);
        const response = await POST(request, params);
        expect(response.status).toBe(413);
        expect(pulled * chunk.byteLength).toBeLessThan(MAX_HOOK_BODY + 4 * chunk.byteLength);
        expect(mocks.runHook).not.toHaveBeenCalled();
    });

    it("passes a body within the limit on, and answers a failed run without its reason", async () => {
        mocks.runHook.mockResolvedValueOnce({ error: "Your role cannot change Amount here." });
        const response = await POST(
            new Request("http://localhost/api/crm/hooks/x", { method: "POST", body: '{"a":1}' }),
            params
        );
        expect(mocks.runHook).toHaveBeenCalledWith(SECRET, '{"a":1}');
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: false });
    });
});
