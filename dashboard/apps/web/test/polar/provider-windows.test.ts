/**
 * The provider's own context window: read from the documented fields only,
 * asked once per key and remembered, never asked of a provider whose API
 * reports none, and a failure is an empty answer rather than an error.
 */

import * as windows from "@/lib/polar/provider-windows";
import { contextWindowOf } from "@/lib/polar/compaction";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: { url: string; headers: Record<string, string> }[] = [];
let answer: (url: string) => Response = () => new Response("{}", { status: 500 });

beforeEach(() => {
    calls.length = 0;
    windows.forgetProviderWindows();
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
            calls.push({ url, headers: init.headers });
            return answer(url);
        })
    );
});

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("reading a models list", () => {
    it("takes Anthropic's max_input_tokens and skips what is missing", () => {
        expect(
            windows.anthropicWindows({
                data: [
                    { id: "claude-a", max_input_tokens: 200_000 },
                    { id: "claude-b", max_input_tokens: null },
                    { id: "claude-c" }
                ]
            })
        ).toEqual(new Map([["claude-a", 200_000]]));
        expect(windows.anthropicWindows(null).size).toBe(0);
    });

    it("takes Gemini's inputTokenLimit, named without models/", () => {
        expect(
            windows.geminiWindows({
                models: [
                    { name: "models/gemini-x", inputTokenLimit: 1_048_576 },
                    { name: "models/embed", inputTokenLimit: 0 }
                ]
            })
        ).toEqual(new Map([["gemini-x", 1_048_576]]));
    });
});

describe("asking the provider", () => {
    it("asks Anthropic once per key, with its headers, and remembers the answer", async () => {
        answer = () => json({ data: [{ id: "claude-a", max_input_tokens: 200_000 }] });
        const key = { provider: "anthropic", secret: "sk-test" };
        expect((await windows.providerWindows(key)).get("claude-a")).toBe(200_000);
        expect((await windows.providerWindows(key)).get("claude-a")).toBe(200_000);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toContain("https://api.anthropic.com/v1/models");
        expect(calls[0]?.headers).toMatchObject({
            "x-api-key": "sk-test",
            "anthropic-version": "2023-06-01"
        });
    });

    it("follows Gemini's pages with the key in a header, never the URL", async () => {
        answer = (url) =>
            url.includes("pageToken=")
                ? json({ models: [{ name: "models/b", inputTokenLimit: 2 }] })
                : json({
                      models: [{ name: "models/a", inputTokenLimit: 1 }],
                      nextPageToken: "next"
                  });
        const found = await windows.providerWindows({ provider: "google-ai", secret: "g-key" });
        expect([...found]).toEqual([
            ["a", 1],
            ["b", 2]
        ]);
        expect(calls.every((call) => !call.url.includes("g-key"))).toBe(true);
        expect(calls[0]?.headers).toEqual({ "x-goog-api-key": "g-key" });
    });

    it("answers nothing, and asks nothing, for a provider that reports no window", async () => {
        expect((await windows.providerWindows({ provider: "openai", secret: "k" })).size).toBe(0);
        expect((await windows.providerWindows(null)).size).toBe(0);
        expect(calls).toHaveLength(0);
    });

    it("answers nothing when the provider fails, and does not ask again at once", async () => {
        answer = () => new Response("{}", { status: 503 });
        const key = { provider: "anthropic", secret: "down" };
        expect((await windows.providerWindows(key)).size).toBe(0);
        expect((await windows.providerWindows(key)).size).toBe(0);
        expect(calls).toHaveLength(1);
    });
});

describe("which window the bar uses", () => {
    it("is the provider's, else the catalogue's, else none", () => {
        expect(contextWindowOf({ provider: 1_000_000, catalogue: 200_000 })).toBe(1_000_000);
        expect(contextWindowOf({ provider: null, catalogue: 200_000 })).toBe(200_000);
        expect(contextWindowOf({ provider: null, catalogue: 0 })).toBeNull();
    });
});
