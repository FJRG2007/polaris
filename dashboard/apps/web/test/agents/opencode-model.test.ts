import { describe, expect, it } from "vitest";
import * as core from "@polaris/core";
import {
    OPENCODE_GATEWAY_ID,
    OPENCODE_KEY_ENV,
    opencodeModelConfig,
    opencodeModelEnv,
    opencodeProviderId
} from "@/lib/agents/opencode-model";

const base = { secret: "sk-test-fixture", baseUrl: null, gatewayModel: null };

describe("opencode provider mapping", () => {
    it("maps Polaris slugs to the model index ids OpenCode uses", () => {
        expect(opencodeProviderId("anthropic")).toBe("anthropic");
        expect(opencodeProviderId("google-ai")).toBe("google");
        expect(opencodeProviderId("moonshot")).toBe("moonshotai");
        expect(opencodeProviderId("opencode")).toBe("opencode");
        expect(opencodeProviderId("opencode-go")).toBe("opencode-go");
        expect(opencodeProviderId("enigma")).toBe(OPENCODE_GATEWAY_ID);
    });

    it("names provider/model and reads the key from the environment, never inline", () => {
        const config = opencodeModelConfig({ ...base, provider: "openrouter", model: "anthropic/claude-x" });
        expect(config.model).toBe("openrouter/anthropic/claude-x");
        expect(config.provider).toEqual({
            openrouter: { options: { apiKey: `{env:${OPENCODE_KEY_ENV}}` } }
        });
        expect(JSON.stringify(config)).not.toContain("sk-test-fixture");
    });

    it("declares a gateway as an OpenAI-compatible provider with its endpoint", () => {
        const config = opencodeModelConfig({
            provider: "enigma",
            model: "ignored",
            secret: "",
            baseUrl: "https://gateway.example.test/v1/",
            gatewayModel: "local-coder"
        });
        expect(config.model).toBe(`${OPENCODE_GATEWAY_ID}/local-coder`);
        expect(config.provider).toEqual({
            [OPENCODE_GATEWAY_ID]: {
                npm: "@ai-sdk/openai-compatible",
                name: "Gateway",
                options: {
                    baseURL: "https://gateway.example.test/v1",
                    apiKey: `{env:${OPENCODE_KEY_ENV}}`
                },
                models: { "local-coder": { name: "local-coder" } }
            }
        });
    });

    it("produces environment values with no control character", () => {
        const env = opencodeModelEnv({ ...base, provider: "anthropic", model: "claude-x" });
        expect(Object.keys(env).sort()).toEqual(["OPENCODE_CONFIG_CONTENT", OPENCODE_KEY_ENV].sort());
        for (const value of Object.values(env)) expect(core.hasControlCharacter(value)).toBe(false);
        expect(env[OPENCODE_KEY_ENV]).toBe("sk-test-fixture");
        expect(opencodeModelEnv({ ...base, secret: "", provider: "enigma", model: "m" })[OPENCODE_KEY_ENV]).toBe("unused");
    });
});

describe("session start schema", () => {
    const start = { title: "t", cli: "opencode", prompt: "go" };
    it("takes a model only for a tool that reads one", () => {
        const choice = { provider: "openai", model: "gpt-x" };
        expect(core.startAgentSessionSchema.safeParse({ ...start, modelChoice: choice }).success).toBe(true);
        expect(
            core.startAgentSessionSchema.safeParse({ ...start, cli: "aider", modelChoice: choice }).success
        ).toBe(false);
    });
    it("bounds attachments and wants a prompt with them", () => {
        const id = "0193b0f0-0000-7000-8000-000000000001";
        expect(core.startAgentSessionSchema.safeParse({ ...start, attachments: [id] }).success).toBe(true);
        expect(
            core.startAgentSessionSchema.safeParse({ ...start, prompt: "", attachments: [id] }).success
        ).toBe(false);
        expect(
            core.startAgentSessionSchema.safeParse({ ...start, attachments: Array(7).fill(id) }).success
        ).toBe(false);
    });
});
