/**
 * The agent and model a repository starts each orchestration role on.
 *
 * Ported from the per-role project settings of AO
 * (`frontend/src/renderer/components/ProjectAgentRoleControls.tsx`, the
 * `worker.agent` / `orchestrator.agent` project config read by `ao spawn`)
 * (Apache-2.0). Three roles: the coordinator that plans a run, the workers it
 * spawns, and a reviewer it spawns to read a pull request without changing it.
 *
 * Stored as one JSON text column on the repository (`AgentRepo.roleAgents`),
 * null for "nothing set", and every role nobody set falls to `ROLE_DEFAULTS`
 * here, in code - so a repository added before this existed, and every
 * deployment that never opened the setting, still resolves to a working agent.
 *
 * Pure: no database, so the screens and the service share one reading.
 */

import { z } from "zod";
import * as core from "@polaris/core";

export const AGENT_ROLES = ["coordinator", "worker", "reviewer"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** A model as `provider/model`, the shape session starts take it in
 *  (`readModelSpec` in session-api). Empty is the agent's own default. */
export const roleModelSchema = z
    .string()
    .trim()
    .max(240)
    .refine((value) => value === "" || isModelSpec(value), { message: "Name the model as provider/model" });

/** `provider/model`, held to the same characters a session start takes. */
function isModelSpec(value: string): boolean {
    const slash = value.indexOf("/");
    if (slash < 1) return false;
    return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value.slice(0, slash)) && core.SAFE_MODEL_ID.test(value.slice(slash + 1));
}

export const roleAgentSchema = z
    .object({
        agent: core.agentCliIdSchema.refine((id) => core.agentCliById(id) !== undefined, {
            message: "Pick an agent"
        }),
        model: roleModelSchema.default("")
    })
    .strict();
export type RoleAgent = z.infer<typeof roleAgentSchema>;

/** What a person saves: any role left out inherits the code default. */
export const roleAgentsSchema = z
    .object({
        coordinator: roleAgentSchema.optional(),
        worker: roleAgentSchema.optional(),
        reviewer: roleAgentSchema.optional()
    })
    .strict();
export type RoleAgents = z.infer<typeof roleAgentsSchema>;

/** Every role resolved. */
export type ResolvedRoleAgents = Record<AgentRole, RoleAgent>;

/** What a role starts on when the repository says nothing. */
export const ROLE_DEFAULTS: ResolvedRoleAgents = {
    coordinator: { agent: "claude", model: "" },
    worker: { agent: "claude", model: "" },
    reviewer: { agent: "claude", model: "" }
};

/** A stored column as the saved roles. Anything unreadable - a row written by
 *  a later build, a hand edit - reads as nothing set rather than throwing:
 *  rows outlive builds. A role that fails on its own is dropped alone. */
export function parseRoleAgents(stored: string | null | undefined): RoleAgents {
    if (!stored) return {};
    let raw: unknown;
    try {
        raw = JSON.parse(stored);
    } catch {
        return {};
    }
    if (!raw || typeof raw !== "object") return {};
    const out: RoleAgents = {};
    for (const role of AGENT_ROLES) {
        const parsed = roleAgentSchema.safeParse((raw as Record<string, unknown>)[role]);
        if (parsed.success) out[role] = parsed.data;
    }
    return out;
}

/** The saved roles as the column stores them; null when nothing is set, so
 *  "never set" and "set to the defaults" stay apart only when a role is. */
export function storeRoleAgents(roles: RoleAgents): string | null {
    const kept = Object.fromEntries(AGENT_ROLES.filter((role) => roles[role]).map((role) => [role, roles[role]]));
    return Object.keys(kept).length > 0 ? JSON.stringify(kept) : null;
}

/** Every role, with what nobody set taken from the code defaults. */
export function resolveRoleAgents(roles: RoleAgents): ResolvedRoleAgents {
    return {
        coordinator: roles.coordinator ?? ROLE_DEFAULTS.coordinator,
        worker: roles.worker ?? ROLE_DEFAULTS.worker,
        reviewer: roles.reviewer ?? ROLE_DEFAULTS.reviewer
    };
}

/**
 * What one start runs on: what the caller asked for first, then the role's
 * saved default. A model saved for a different agent than the one asked for
 * is not carried over - a Codex model on Claude Code is a start that fails.
 */
export function pickRoleAgent(
    saved: RoleAgents,
    role: AgentRole,
    asked: { agent?: string | null; model?: string | null }
): RoleAgent {
    const base = resolveRoleAgents(saved)[role];
    const agent = asked.agent || base.agent;
    const model = asked.model ? asked.model : agent === base.agent ? base.model : "";
    return { agent, model };
}
