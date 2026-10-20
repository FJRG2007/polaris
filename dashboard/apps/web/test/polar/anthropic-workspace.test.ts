/**
 * An Anthropic key that is not tied to one workspace names its workspace on
 * every call Polar makes with it, or Anthropic answers 400 to every one.
 * https://platform.claude.com/docs/en/manage-claude/authentication#select-a-workspace
 */

import { describe, expect, it, vi } from "vitest";

const made = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@ai-sdk/anthropic", () => ({
    createAnthropic: (settings: Record<string, unknown>) => {
        made.push(settings);
        return (model: string) => ({ model });
    }
}));

// Nothing here reads the database; the model module only imports it.
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/session", () => ({ requireUser: vi.fn(), getSession: vi.fn() }));

const { languageModel } = await import("@/lib/polar/models");

const base = { provider: "anthropic", source: "own" as const, baseUrl: null, gatewayModel: null };

describe("languageModel for Anthropic", () => {
    it("sends the workspace header when the key names a workspace", () => {
        made.length = 0;
        languageModel(
            { ...base, secret: "sk-ant-usr-x", workspaceId: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" },
            "claude-sonnet-4-5"
        );
        expect(made[0]).toMatchObject({
            apiKey: "sk-ant-usr-x",
            headers: { "anthropic-workspace-id": "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" }
        });
    });

    it("sends no extra header for a key tied to its workspace", () => {
        made.length = 0;
        languageModel({ ...base, secret: "sk-ant-api-x" }, "claude-sonnet-4-5");
        expect(made[0]?.headers).toEqual({});
    });
});
