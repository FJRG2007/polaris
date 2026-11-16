/**
 * Copilot answers GPT-5 and later (GPT-5 mini aside), Grok and MAI Code only
 * on `/responses`, so those are sent there and the rest to
 * `/chat/completions`, as OpenCode routes them.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { copilotEndpoint, copilotListsModel } from "@/lib/agents/signin-copilot";
import { copilotModel } from "@/lib/polar/login-models";
import type { ChatCredential } from "@/lib/agents/model-keys";

const CREDENTIAL = {
    provider: "github-copilot",
    source: "own",
    secret: "gho_fixture",
    oauth: { apiEndpoint: null }
} as unknown as ChatCredential;

/** The address and headers a model's first call goes to. */
async function firstCall(model: string): Promise<{ url: string; headers: Headers; body: Record<string, unknown> }> {
    const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        throw new Error("stop");
    });
    const language = copilotModel(CREDENTIAL, model);
    if (typeof language === "string") throw new Error("expected a model object");
    await language
        .doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
        .catch(() => undefined);
    return seen[0]!;
}

afterEach(() => vi.unstubAllGlobals());

describe("Copilot's endpoint by model", () => {
    it.each([
        ["gpt-5", "responses"],
        ["gpt-5.1-codex", "responses"],
        ["gpt-6", "responses"],
        ["grok-code-fast-1", "responses"],
        ["mai-code-1", "responses"],
        ["gpt-5-mini", "chat"],
        ["gpt-4.1", "chat"],
        ["gpt-4o", "chat"],
        ["claude-sonnet-4.5", "chat"],
        ["gemini-2.5-pro", "chat"]
    ])("%s answers on %s", (model, endpoint) => {
        expect(copilotEndpoint(model)).toBe(endpoint);
    });

    it("leaves out the chat-only GPT-5 alias", () => {
        expect(copilotListsModel("gpt-5-chat-latest")).toBe(false);
        expect(copilotListsModel("gpt-5")).toBe(true);
    });

    it("sends a GPT-5 model to /responses with Copilot's headers", async () => {
        const call = await firstCall("gpt-5");
        expect(call.url).toBe("https://api.githubcopilot.com/responses");
        expect(call.headers.get("authorization")).toBe("Bearer gho_fixture");
        expect(call.headers.get("openai-intent")).toBe("conversation-edits");
        expect(call.body).toMatchObject({ model: "gpt-5", store: false, include: ["reasoning.encrypted_content"] });
    });

    it("sends the rest to /chat/completions", async () => {
        const call = await firstCall("gpt-4.1");
        expect(call.url).toBe("https://api.githubcopilot.com/chat/completions");
        expect(call.headers.get("authorization")).toBe("Bearer gho_fixture");
    });
});
