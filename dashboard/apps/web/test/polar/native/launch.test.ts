// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { launchModel, launchSession, readLaunchEnv, sessionRoutes, transcriptPathOf } from "@/lib/polar/native/launch";

const ENV = {
    POLARIS_URL: "https://polaris.test/",
    POLARIS_SESSION_ID: "s_123",
    POLARIS_SESSION_TOKEN: "t".repeat(32),
    POLARIS_MODEL: "openai/gpt-5",
    POLARIS_WORKDIR: "/work/repo"
};

describe("readLaunchEnv", () => {
    it("reads a complete environment, with the address trimmed and the place defaulted", () => {
        const read = readLaunchEnv(ENV);
        expect("config" in read && read.config).toMatchObject({ POLARIS_URL: "https://polaris.test", POLARIS_PLACE: "container" });
    });

    it("names every missing or malformed variable, never a value", () => {
        const read = readLaunchEnv({ ...ENV, POLARIS_URL: "ftp://x", POLARIS_SESSION_TOKEN: "short", POLARIS_MODEL: undefined });
        expect(read).toEqual({ invalid: ["POLARIS_MODEL", "POLARIS_SESSION_TOKEN", "POLARIS_URL"] });
        expect(JSON.stringify(read)).not.toContain("short");
    });

    it("refuses a session id that could leave its route", () => {
        expect(readLaunchEnv({ ...ENV, POLARIS_SESSION_ID: "../x" })).toEqual({ invalid: ["POLARIS_SESSION_ID"] });
    });
});

describe("the session's routes and transcript", () => {
    it("points hooks at the session's routes and the model at the compatible API", () => {
        expect(sessionRoutes({ POLARIS_URL: "https://polaris.test", POLARIS_SESSION_ID: "s_123" })).toEqual({
            events: "https://polaris.test/api/agents/sessions/s_123/events",
            permission: "https://polaris.test/api/agents/sessions/s_123/permission",
            models: "https://polaris.test/api/v1"
        });
    });

    it("writes the transcript where it is told, else under the home folder", () => {
        const read = readLaunchEnv(ENV);
        if (!("config" in read)) throw new Error("invalid");
        expect(transcriptPathOf({ ...read.config, POLARIS_TRANSCRIPT: "/tmp/t.jsonl" })).toBe("/tmp/t.jsonl");
        expect(transcriptPathOf(read.config)).toMatch(/s_123\.jsonl$/);
    });
});

describe("launchModel", () => {
    it("calls Polaris's chat completions with the session token, never a provider key", async () => {
        const read = readLaunchEnv(ENV);
        if (!("config" in read)) throw new Error("invalid");
        const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
            Response.json({
                id: "c1",
                object: "chat.completion",
                created: 0,
                model: "openai/gpt-5",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
            })
        );
        const model = launchModel(read.config, fetchImpl as unknown as typeof fetch);
        const result = await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as never);
        expect(result.content).toEqual([{ type: "text", text: "ok" }]);
        const [url, init] = fetchImpl.mock.calls[0]!;
        expect(String(url)).toBe("https://polaris.test/api/v1/chat/completions");
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${"t".repeat(32)}`);
        expect(JSON.parse(String(init?.body))).toMatchObject({ model: "openai/gpt-5" });
    });
});

describe("launchSession", () => {
    it("builds a session on the given workspace and hooks", () => {
        const read = readLaunchEnv(ENV);
        if (!("config" in read)) throw new Error("invalid");
        const hooks = { event: async () => undefined, decide: async () => ({}) };
        const session = launchSession(read.config, { hooks, writeTranscript: () => undefined });
        expect(session.history()).toEqual([]);
    });
});
