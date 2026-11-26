/**
 * The models a Copilot login can call, read from its own `/models` listing
 * and kept a while, so Automatic never picks one the login cannot reach.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    copilotModels,
    copilotModelsFor,
    copilotModelsIn,
    forgetCopilotModels
} from "@/lib/polar/copilot-models";

const usable = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id.toUpperCase(),
    capabilities: {
        limits: { max_prompt_tokens: 64_000, max_output_tokens: 8_000, max_context_window_tokens: 128_000 },
        supports: { tool_calls: true }
    },
    ...extra
});

beforeEach(() => forgetCopilotModels());

describe("copilotModelsIn", () => {
    it("keeps the models the login can call", () => {
        const body = {
            data: [
                usable("gpt-4.1"),
                usable("off", { policy: { state: "disabled" } }),
                { id: "embed", capabilities: { limits: {}, supports: {} } },
                usable("gpt-4.1")
            ]
        };
        expect(copilotModelsIn(body)).toEqual([{ id: "gpt-4.1", name: "GPT-4.1", contextTokens: 128_000 }]);
    });

    it("is null for something that is not a listing", () => {
        expect(copilotModelsIn({ error: "nope" })).toBeNull();
    });
});

describe("copilotModels", () => {
    const credential = { secret: "copilot-token", oauth: null } as never;

    it("asks once and keeps the answer", async () => {
        const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [usable("claude-sonnet-4")] })));
        const first = await copilotModels(credential, { fetch, now: 1_000 });
        const second = await copilotModels(credential, { fetch, now: 2_000 });
        expect(first?.map((model) => model.id)).toEqual(["claude-sonnet-4"]);
        expect(second).toEqual(first);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("is null when Copilot refuses and there is nothing kept", async () => {
        const fetch = vi.fn(async () => new Response("no", { status: 401 }));
        expect(await copilotModels(credential, { fetch })).toBeNull();
    });

    it("is null without a login", async () => {
        expect(await copilotModels(null)).toBeNull();
    });

    it("merges what several logins reach", async () => {
        const fetch = vi.fn(async (_url: string, init: RequestInit) => {
            const auth = new Headers(init.headers).get("Authorization");
            const id = auth === "Bearer a" ? "gpt-4.1" : "o4-mini";
            return new Response(JSON.stringify({ data: [usable(id)] }));
        });
        const merged = await copilotModelsFor(
            [{ secret: "a", oauth: null } as never, { secret: "b", oauth: null } as never],
            { fetch }
        );
        expect(merged?.map((model) => model.id).sort()).toEqual(["gpt-4.1", "o4-mini"]);
    });
});
