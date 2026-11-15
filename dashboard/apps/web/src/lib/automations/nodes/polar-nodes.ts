/**
 * Polar's steps: write a text, run an agent with tools, decide between named
 * outcomes, extract typed fields. Shaped after n8n's AI nodes (Basic LLM
 * Chain, AI Agent, Text Classifier, Information Extractor -
 * docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes): the classifier
 * leaves by one port per category with a fallback, the extractor fills a
 * schema the node declares, and the agent's loop is bounded by steps, tokens
 * and time. Every answer the model gives is checked with zod before a later
 * step reads it.
 *
 * Each runs on the automation owner's Polar access, keys and limits
 * (`polar-model.ts`). The agent is handed only tools that change nothing: an
 * automation runs unattended, and nobody is there to approve a write.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { polarAsker, polarStepSystem } from "./polar-model";
import { stepCountIs, type StopCondition, type ToolSet } from "ai";
import { StepError, StepRefusal, type NodeResult, type ServerNode } from "../types";

type Config<T extends keyof typeof core.CORE_NODE_CONFIGS> = z.infer<
    (typeof core.CORE_NODE_CONFIGS)[T]
>;

/** Tools one agent step is offered at most, ranked against its task. */
const AGENT_TOOLS = 16;
/** The longest answer of one model call in an agent's loop. */
const AGENT_STEP_TOKENS = 4_096;
/** Answers a structured step reads back: a decision or a few fields. */
const STRUCTURED_TOKENS = 1_024;

function prompt(template: string, context: Parameters<typeof core.interpolate>[1]): string {
    const text = core.interpolate(template, context).trim();
    if (!text) throw new StepError("inputRequired");
    return text;
}

/** The JSON object in a model's answer, tolerating a fence or a sentence around it. */
export function answerObject(text: string): unknown {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
}

/**
 * Ask for JSON, check it with `schema`, and ask once more when the answer did
 * not fit: models that follow instructions loosely usually get it right the
 * second time. Null when neither answer fits.
 */
async function askStructured<T>(
    asker: Awaited<ReturnType<typeof polarAsker>>,
    input: { system: string; prompt: string; signal: AbortSignal },
    schema: z.ZodType<T, z.ZodTypeDef, unknown>
): Promise<T | null> {
    let prompt = input.prompt;
    for (let attempt = 0; attempt < 2; attempt++) {
        const answer = await asker.ask({ ...input, prompt, maxOutputTokens: STRUCTURED_TOKENS });
        const parsed = schema.safeParse(answerObject(answer.text));
        if (parsed.success) return parsed.data;
        prompt = `${input.prompt}\n\nYour last answer was not the JSON object asked for. Answer with that JSON object only.`;
    }
    return null;
}

export const aiWriteNode: ServerNode<Config<"core.aiWrite">> = {
    type: "core.aiWrite",
    meta: core.CORE_NODE_META["core.aiWrite"],
    config: core.CORE_NODE_CONFIGS["core.aiWrite"],
    run: async (config, context, io) => {
        io.recordInput({ agentId: config.agentId || null, model: config.model });
        const asked = prompt(config.prompt, context);
        const asker = await polarAsker(io, config);
        const answer = await asker.ask({
            system: polarStepSystem(asker.instructions, "Write exactly the text the step asks for."),
            prompt: asked,
            maxOutputTokens: config.maxTokens,
            signal: io.signal
        });
        if (!answer.text) throw new StepError("polarEmpty");
        return { output: { text: answer.text, model: answer.model } };
    }
};

/** Stops an agent's loop once its steps together have spent `budget` tokens. */
export function tokenBudget(budget: number): StopCondition<ToolSet> {
    return ({ steps }) =>
        steps.reduce((sum, step) => sum + (step.usage.totalTokens ?? 0), 0) >= budget;
}

export const aiAgentNode: ServerNode<Config<"core.aiAgent">> = {
    type: "core.aiAgent",
    meta: core.CORE_NODE_META["core.aiAgent"],
    config: core.CORE_NODE_CONFIGS["core.aiAgent"],
    // The node's own limit (at most 600 s) ends it first, with its own reason.
    timeoutMs: 610_000,
    run: async (config, context, io) => {
        io.recordInput({
            agentId: config.agentId || null,
            model: config.model,
            maxSteps: config.maxSteps
        });
        const task = prompt(config.task, context);
        const asker = await polarAsker(io, config);
        const [{ polarTools }, { rankTools }] = await Promise.all([
            import("@/lib/polar/tools"),
            import("@/lib/polar/tool-relevance")
        ]);
        const set = await polarTools(asker.user);
        const readers = set.catalog.filter((entry) => set.described[entry.name]?.writes === false);
        const ranked = rankTools(readers, task, AGENT_TOOLS);
        const tools: ToolSet = Object.fromEntries(
            (ranked.length > 0 ? ranked : readers.slice(0, AGENT_TOOLS)).map((entry) => [
                entry.name,
                set.tools[entry.name]!
            ])
        );
        const signal = AbortSignal.any([
            io.signal,
            AbortSignal.timeout(config.timeoutSeconds * 1000)
        ]);
        const answer = await asker.ask({
            system: polarStepSystem(
                asker.instructions,
                "Carry out the task with the tools you have. They only read: you cannot change anything. Finish with the answer the next steps need."
            ),
            prompt: task,
            maxOutputTokens: Math.min(AGENT_STEP_TOKENS, config.maxTokens),
            signal,
            tools,
            stopWhen: [stepCountIs(config.maxSteps), tokenBudget(config.maxTokens)]
        });
        if (!answer.text) throw new StepError("polarEmpty");
        return { output: { text: answer.text, steps: answer.steps, model: answer.model } };
    }
};

const decisionSchema = z.object({
    outcome: z.string().trim().min(1).max(200),
    reason: z.string().max(1000).optional().default("")
});

/** Where a decision goes when it could not be made, as `onFailure` says. */
export function decisionFallback(
    config: Config<"core.aiDecide">,
    code: string,
    leads: (port: string) => boolean
): NodeResult {
    const failed = { failed: true, error: code, outcome: null, label: null, reason: "" };
    if (config.onFailure === "fail") throw new StepError(code);
    if (config.onFailure === "error") {
        // A fallback with nothing wired to it would end the lane in silence.
        if (!leads("error")) throw new StepError(code);
        return { output: failed, port: "error" };
    }
    const index = Number(config.onFailure.slice(4)) - 1;
    const label = config.cases[index]?.label.trim();
    if (!label) throw new StepError(code);
    return { output: { ...failed, outcome: config.onFailure, label }, port: config.onFailure };
}

export const aiDecideNode: ServerNode<Config<"core.aiDecide">> = {
    type: "core.aiDecide",
    meta: core.CORE_NODE_META["core.aiDecide"],
    config: core.CORE_NODE_CONFIGS["core.aiDecide"],
    run: async (config, context, io) => {
        io.recordInput({ outcomes: config.cases.map((entry) => entry.label) });
        const input = prompt(config.input, context);
        const labels = config.cases.map((entry) => entry.label.trim());
        let decided: z.infer<typeof decisionSchema> | null;
        try {
            const asker = await polarAsker(io, config);
            const outcomes = config.cases
                .map(
                    (entry) =>
                        `- ${entry.label.trim()}${entry.description.trim() ? `: ${entry.description.trim()}` : ""}`
                )
                .join("\n");
            decided = await askStructured(
                asker,
                {
                    system: polarStepSystem(
                        asker.instructions,
                        [
                            "Decide which one of these outcomes fits the input. Pick exactly one, spelled as given.",
                            `Outcomes:\n${outcomes}`,
                            config.instructions.trim()
                                ? `How to decide: ${core.interpolate(config.instructions, context)}`
                                : "",
                            'Answer with JSON only: {"outcome": "<one outcome>", "reason": "<one short sentence>"}'
                        ]
                            .filter(Boolean)
                            .join("\n\n")
                    ),
                    prompt: input,
                    signal: io.signal
                },
                decisionSchema
            );
        } catch (error) {
            if (error instanceof StepRefusal || !(error instanceof StepError)) throw error;
            return decisionFallback(config, error.code, io.leads);
        }
        const index = decided
            ? labels.findIndex((label) => label.toLowerCase() === decided.outcome.toLowerCase())
            : -1;
        if (!decided || index < 0) return decisionFallback(config, "polarNoOutcome", io.leads);
        return {
            output: {
                outcome: `case${index + 1}`,
                label: labels[index],
                reason: decided.reason,
                failed: false
            },
            port: `case${index + 1}`
        };
    }
};

const FIELD_VALUES: Record<core.AiFieldKind, z.ZodTypeAny> = {
    text: z.union([z.string(), z.number()]).transform(String),
    number: z.preprocess(
        (value) => (typeof value === "string" && value.trim() !== "" ? Number(value) : value),
        z.number().finite()
    ),
    boolean: z.preprocess(
        (value) => (value === "true" ? true : value === "false" ? false : value),
        z.boolean()
    ),
    date: z
        .string()
        .refine((value) => !Number.isNaN(Date.parse(value)), "date")
        .transform((value) => new Date(value).toISOString()),
    list: z.array(z.unknown()).max(500)
};

/** The schema an extraction's answer must fit: every field, null when the text does not say. */
export function extractionSchema(fields: Config<"core.aiExtract">["fields"]) {
    return z.object(
        Object.fromEntries(
            fields.map((field) => [
                field.name,
                FIELD_VALUES[field.kind].nullable().optional().catch(null)
            ])
        )
    );
}

export const aiExtractNode: ServerNode<Config<"core.aiExtract">> = {
    type: "core.aiExtract",
    meta: core.CORE_NODE_META["core.aiExtract"],
    config: core.CORE_NODE_CONFIGS["core.aiExtract"],
    run: async (config, context, io) => {
        io.recordInput({ fields: config.fields.map((field) => field.name) });
        const text = prompt(config.text, context);
        const asker = await polarAsker(io, config);
        const shape = config.fields
            .map(
                (field) =>
                    `- ${field.name} (${field.kind === "list" ? "array" : field.kind === "date" ? "ISO 8601 date" : field.kind}${field.required ? ", required" : ""})${field.description.trim() ? `: ${field.description.trim()}` : ""}`
            )
            .join("\n");
        const found = await askStructured(
            asker,
            {
                system: polarStepSystem(
                    asker.instructions,
                    [
                        "Extract these fields from the text. Use null for a field the text does not give; never invent a value.",
                        `Fields:\n${shape}`,
                        "Answer with one JSON object holding exactly these keys, and nothing else."
                    ].join("\n\n")
                ),
                prompt: text,
                signal: io.signal
            },
            extractionSchema(config.fields)
        );
        if (!found) throw new StepError("polarNoFields");
        const fields: Record<string, unknown> = {};
        for (const field of config.fields) fields[field.name] = found[field.name] ?? null;
        const missing = config.fields
            .filter((field) => field.required && fields[field.name] === null)
            .map((field) => field.name);
        if (missing.length > 0) throw new StepError("extractMissing", { fields, missing });
        return { output: { fields, missing } };
    }
};

export const POLAR_SERVER_NODES = [aiWriteNode, aiAgentNode, aiDecideNode, aiExtractNode];
