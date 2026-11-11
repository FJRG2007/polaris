/**
 * Custom Polar agents, as ChatGPT's GPTs: what one is, as the settings editor
 * and the server both check it. One schema, read by the form on every
 * keystroke and by every action and the chat route before anything is stored
 * or reaches a model.
 *
 * An agent is a name, a line on what it is for, the instructions it follows,
 * the skills and connectors it may use (none listed means the person's usual
 * ones), whether it reads the web, and the model it answers on (null is
 * Automatic). Client-safe.
 */

import { z } from "zod";
import { modelChoiceSchema, type ModelChoice } from "@/lib/polar/shared";

export const AGENT_NAME_MAX = 80;
export const AGENT_DESCRIPTION_MAX = 500;
export const AGENT_INSTRUCTIONS_MAX = 20_000;
/** More agents than one person keeps; bounds every list. */
export const AGENT_LIMIT = 50;
/** Skills or connectors one agent lists. */
export const AGENT_PICKS_MAX = 50;

/** The one form a name is kept in: trimmed, inner runs of spaces as one. */
export function normalizeAgentName(raw: string): string {
    return raw.trim().replace(/\s+/g, " ");
}

export const agentFieldSchemas = {
    name: z.string().transform(normalizeAgentName).pipe(z.string().min(1).max(AGENT_NAME_MAX)),
    description: z.string().trim().max(AGENT_DESCRIPTION_MAX),
    instructions: z.string().trim().min(1).max(AGENT_INSTRUCTIONS_MAX)
};

export const agentInputSchema = z.object({
    ...agentFieldSchemas,
    skills: z.array(z.string().trim().min(1).max(64)).max(AGENT_PICKS_MAX).default([]),
    connectorIds: z.array(z.string().uuid()).max(AGENT_PICKS_MAX).default([]),
    web: z.boolean().default(true),
    choice: modelChoiceSchema.nullable().default(null)
});
export type AgentInput = z.infer<typeof agentInputSchema>;
export type AgentTextField = keyof typeof agentFieldSchemas;

/** Why a text field is not right yet: null when fine or simply not filled in. */
export function agentFieldError(field: AgentTextField, value: string): "too_long" | null {
    if (!value.trim()) return null;
    const checked = agentFieldSchemas[field].safeParse(value);
    return !checked.success && checked.error.issues[0]?.code === "too_big" ? "too_long" : null;
}

/** An agent as the settings screen shows it. */
export interface AgentView {
    id: string;
    name: string;
    description: string;
    instructions: string;
    skills: string[];
    connectorIds: string[];
    web: boolean;
    choice: ModelChoice | null;
}

/** The text an agent puts in front of the model, after Polar's own rules. */
export function agentPrompt(agent: Pick<AgentView, "name" | "instructions">): string {
    return [
        `In this chat you are "${agent.name}", an agent the person set up. They wrote these instructions for it; follow them unless they conflict with the rules above:`,
        "<agent_instructions>",
        agent.instructions.replaceAll("</agent_instructions>", "</ agent_instructions>"),
        "</agent_instructions>"
    ].join("\n");
}
