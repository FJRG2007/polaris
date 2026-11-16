/**
 * Per-role agent defaults: what a repository saves, what nobody saved falls
 * to, and what one start ends up on.
 */

import { describe, expect, it } from "vitest";
import * as roles from "@/lib/agents/agent-roles";

describe("agent roles", () => {
    it("falls to the code defaults when nothing is stored", () => {
        expect(roles.parseRoleAgents(null)).toEqual({});
        expect(roles.resolveRoleAgents({})).toEqual(roles.ROLE_DEFAULTS);
    });

    it("reads unreadable rows as nothing set, and drops a bad role alone", () => {
        expect(roles.parseRoleAgents("{not json")).toEqual({});
        expect(
            roles.parseRoleAgents(
                JSON.stringify({ worker: { agent: "codex", model: "openai/gpt-5" }, reviewer: { agent: "nope" } })
            )
        ).toEqual({ worker: { agent: "codex", model: "openai/gpt-5" } });
    });

    it("stores nothing for nothing set, and round-trips what is", () => {
        expect(roles.storeRoleAgents({})).toBeNull();
        const saved = { coordinator: { agent: "claude", model: "" } };
        expect(roles.parseRoleAgents(roles.storeRoleAgents(saved))).toEqual(saved);
    });

    it("validates models as provider/model", () => {
        expect(roles.roleModelSchema.safeParse("").success).toBe(true);
        expect(roles.roleModelSchema.safeParse("anthropic/claude-sonnet-4").success).toBe(true);
        expect(roles.roleModelSchema.safeParse("claude-sonnet-4").success).toBe(false);
        expect(roles.roleModelSchema.safeParse("a/b; rm -rf /").success).toBe(false);
        expect(roles.roleAgentsSchema.safeParse({ worker: { agent: "claude", extra: 1 } }).success).toBe(false);
    });

    it("picks what was asked first, then the role's default", () => {
        const saved = { worker: { agent: "codex", model: "openai/gpt-5" } };
        expect(roles.pickRoleAgent(saved, "worker", {})).toEqual({ agent: "codex", model: "openai/gpt-5" });
        expect(roles.pickRoleAgent(saved, "worker", { model: "openai/o3" })).toEqual({
            agent: "codex",
            model: "openai/o3"
        });
        // A model saved for another agent is not carried over.
        expect(roles.pickRoleAgent(saved, "worker", { agent: "claude" })).toEqual({ agent: "claude", model: "" });
        expect(roles.pickRoleAgent(saved, "reviewer", {})).toEqual(roles.ROLE_DEFAULTS.reviewer);
    });
});
