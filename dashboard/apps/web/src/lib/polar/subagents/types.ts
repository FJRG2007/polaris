/**
 * The kinds of subagent a chat can start: the two that come with Polar, and
 * each of the person's own Polar agents (`lib/polar/agents`), whose
 * description is what the parent delegates by - as Claude Code reads a
 * subagent's `description` and opencode an agent's in `mode: subagent`.
 */

import type { BuiltInType } from "@/lib/polar/subagents/shared";
import { POLAR_ENGINE, type AgentView } from "@/lib/polar/agents/shared";

export interface SubagentType {
    kind: BuiltInType | "agent";
    /** What the parent names it by. */
    name: string;
    description: string;
    instructions: string;
    readOnly: boolean;
    /** Whether it may use the web tools the parent has. */
    web: boolean;
    agent: AgentView | null;
}

const GENERAL: SubagentType = {
    kind: "general",
    name: "general",
    description:
        "General-purpose: research a question or carry out a multi-step task on its own, with the same tools as this chat.",
    instructions: "",
    readOnly: false,
    web: true,
    agent: null
};

const EXPLORE: SubagentType = {
    kind: "explore",
    name: "explore",
    description:
        "Read-only: find and read things (Polaris data, the web, repositories) and report what it found. It changes nothing.",
    instructions:
        "You are read-only: look things up and report. Never try to create, change or delete anything.",
    readOnly: true,
    web: true,
    agent: null
};

/** Every type this person can start, built-ins first. */
export function subagentTypes(agents: readonly AgentView[]): SubagentType[] {
    const own = agents
        .filter((agent) => agent.engine === POLAR_ENGINE && agent.description.trim() !== "")
        .filter((agent) => agent.name !== GENERAL.name && agent.name !== EXPLORE.name)
        .map(
            (agent): SubagentType => ({
                kind: "agent",
                name: agent.name,
                description: agent.description.trim(),
                instructions: agent.instructions,
                readOnly: false,
                web: agent.web,
                agent
            })
        );
    return [GENERAL, EXPLORE, ...own];
}

/** The type a name stands for, matched without case; null when none does. */
export function findSubagentType(
    types: readonly SubagentType[],
    name: string
): SubagentType | null {
    const wanted = name.trim().toLowerCase();
    return types.find((type) => type.name.toLowerCase() === wanted) ?? null;
}

/** The lines of the task tool's description that list the types. */
export function typesDescription(types: readonly SubagentType[]): string {
    return types
        .map((type) => `- ${type.name}: ${type.description.replace(/\s+/g, " ").slice(0, 300)}`)
        .join("\n");
}
