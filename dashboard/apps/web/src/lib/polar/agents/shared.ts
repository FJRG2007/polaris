/**
 * Custom Polar agents, as ChatGPT's GPTs: what one is, as the settings editor
 * and the server both check it. One schema, read by the form on every
 * keystroke and by every action and the chat route before anything is stored
 * or reaches a model.
 *
 * An agent is a name, a line on what it is for, the instructions it follows,
 * the skills and connectors it may use (none listed means the person's usual
 * ones), whether it reads the web, what does the work (`engine`: Polar itself,
 * or a coding tool such as Claude Code), the account it signs in with, and the
 * models it may use, best first. Client-safe.
 *
 * The models list follows the pattern GitHub Copilot's custom agents use
 * (`model:` as an ordered list, code.visualstudio.com/docs/agents/reference/
 * custom-agent-file-reference): the first that can be used answers, and the
 * policy says whether the composer may pick something else ("preferred") or
 * must keep to the list ("required").
 */

import { z } from "zod";
import { isAutomatic, modelChoiceSchema, type ModelChoice } from "@/lib/polar/shared";

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

/** Polar itself as an agent's engine; any other value is a coding tool's id. */
export const POLAR_ENGINE = "polar";
/** The account value that means "the machine's own login". */
export const MACHINE_ACCOUNT = "machine";
/** Where Code keeps the agent picked last ("polar", "tool:<cli>" or
 *  "agent:<id>"), so a link can open a new task on one. */
export const CODE_AGENT_STORAGE_KEY = "polar.code.agent";
/** The composer's key for one of the person's own agents. */
export const customAgentKey = (id: string) => `agent:${id}`;
/** The composer's key for a coding tool that comes with Polaris. */
export const toolAgentKey = (cli: string) => `tool:${cli}`;
/** Models one agent lists. */
export const AGENT_MODELS_MAX = 20;
export const MODEL_POLICIES = ["preferred", "required"] as const;
export type ModelPolicy = (typeof MODEL_POLICIES)[number];

/** One model an agent may use: a provider and its model id. For Polar the
 *  provider is the key's integration (or `auto`); for a coding tool it is the
 *  model index provider the tool runs (`anthropic` for Claude Code). */
export const agentModelSchema = z.object({
    provider: z.string().trim().min(1).max(64),
    model: z.string().trim().min(1).max(200)
});
export type AgentModel = z.infer<typeof agentModelSchema>;

/** What an agent works with: engine, account and models. Shared with the
 *  settings of the agents that come with Polaris. */
export const agentWorkSchema = z.object({
    engine: z.string().trim().min(1).max(32).default(POLAR_ENGINE),
    account: z.union([z.literal(MACHINE_ACCOUNT), z.string().uuid()]).nullable().default(null),
    models: z
        .array(agentModelSchema)
        .max(AGENT_MODELS_MAX)
        .default([])
        // The same model twice is one entry.
        .transform((list) =>
            list.filter(
                (entry, index) =>
                    list.findIndex(
                        (other) => other.provider === entry.provider && other.model === entry.model
                    ) === index
            )
        ),
    modelPolicy: z.enum(MODEL_POLICIES).default("preferred")
});
export type AgentWork = z.infer<typeof agentWorkSchema>;

export const agentInputSchema = z
    .object({
        ...agentFieldSchemas,
        skills: z.array(z.string().trim().min(1).max(64)).max(AGENT_PICKS_MAX).default([]),
        connectorIds: z.array(z.string().uuid()).max(AGENT_PICKS_MAX).default([]),
        web: z.boolean().default(true),
        /** Kept for what reads an agent's one model (automations, older
         *  clients); written from `models[0]` when that is sent. */
        choice: modelChoiceSchema.nullable().default(null)
    })
    .merge(agentWorkSchema);
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
    engine: string;
    account: string | null;
    models: AgentModel[];
    modelPolicy: ModelPolicy;
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

/**
 * The models a chat turn with an agent tries, in order. The agent's list
 * first; a model picked in the chat that is on the list leads it; and, unless
 * the agent keeps to its list, the chat's own pick is the last resort. An
 * agent with no list answers on whatever the chat picked.
 */
export function agentTurnChoices(
    agent: Pick<AgentView, "models" | "modelPolicy"> | null,
    picked: ModelChoice
): ModelChoice[] {
    if (!agent || agent.models.length === 0) return [picked];
    const listed: ModelChoice[] = agent.models.map((entry) => ({
        kind: "language",
        provider: entry.provider,
        model: entry.model,
        intelligence: picked.intelligence,
        payer: null
    }));
    const onList = listed.findIndex(
        (entry) => entry.provider === picked.provider && entry.model === picked.model
    );
    if (onList >= 0) return [picked, ...listed.filter((_, index) => index !== onList)];
    return agent.modelPolicy === "required" ? listed : [...listed, picked];
}

/**
 * The models a plain Polar chat turn tries, from Polar's own settings as an
 * agent. A model picked in the chat answers, unless Polar keeps to a list it
 * is not on; Automatic means "Polar's preferred", so the list goes first.
 */
export function polarTurnChoices(
    work: Pick<AgentWork, "models" | "modelPolicy"> | null,
    picked: ModelChoice
): ModelChoice[] {
    if (!work || work.models.length === 0) return [picked];
    const onList = work.models.some(
        (entry) => entry.provider === picked.provider && entry.model === picked.model
    );
    if (!isAutomatic(picked) && (onList || work.modelPolicy === "preferred")) return [picked];
    return agentTurnChoices(work, picked);
}

/** The longest first prompt a session takes (`startAgentSessionSchema`). */
export const TASK_PROMPT_MAX = 20_000;

/**
 * A Code task's first prompt on one of the person's own agents: its
 * instructions in front of what the task says, so a coding tool with no place
 * for a system prompt still works the way the agent was set up to. The task
 * is kept whole; instructions that do not fit are cut, and say so.
 */
export function agentTaskPrompt(
    agent: Pick<AgentView, "name" | "instructions">,
    task: string,
    max = TASK_PROMPT_MAX
): string {
    const head = `You are working as "${agent.name}", an agent the person set up. Follow these instructions:`;
    const open = "<agent_instructions>";
    const close = "</agent_instructions>";
    const cut = "\n[The rest of the instructions did not fit.]";
    const fixed = [head, open, close, "", task].join("\n").length + 1;
    const room = max - fixed;
    let instructions = agent.instructions.replaceAll(close, "</ agent_instructions>");
    if (room <= cut.length) return task.slice(0, max);
    if (instructions.length > room) instructions = instructions.slice(0, room - cut.length) + cut;
    return [head, open, instructions, close, "", task].join("\n");
}
