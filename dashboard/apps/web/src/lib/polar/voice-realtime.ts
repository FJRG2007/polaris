/**
 * A realtime voice call on a Code session, OpenAI's speech-to-speech model
 * over WebRTC, the way OpenCode's experimental realtime voice runs
 * (`packages/ai/src/experimental/realtime.ts`, github.com/sst/opencode, MIT).
 *
 * The browser never sees the person's key: this mints a client secret that
 * lasts a minute (developers.openai.com/api/docs/guides/realtime-webrtc), with
 * the delegator's instructions and its session tools on it, and the browser
 * opens the call with that. The model's tool calls come back through
 * `/api/polar/voice/realtime/tool`, which runs them here with `voiceTools` -
 * the same tools and access checks as the delegator's own turn.
 *
 * Server-only.
 */

import { z } from "zod";
import { asSchema } from "ai";
import type { RealtimeGrant, RealtimeToolAnswer } from "@/lib/polar/voice-call";
import {
    delegatorInstructions,
    voiceTools,
    type DelegateDeps,
    type DelegateOutcome
} from "@/lib/polar/voice-delegate";

export const REALTIME_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
export const REALTIME_MODEL = "gpt-realtime-2.1";
export const REALTIME_VOICE = "marin";
/** How long the minted secret may be used to open the call. */
const SECRET_SECONDS = 60;
const MINT_TIMEOUT_MS = 15_000;
/** Longest tool output handed back to the model. */
const OUTPUT_MAX = 32 * 1024;
/** How long one tool call may take, a 60 s wait for a session included. */
const TOOL_TIMEOUT_MS = 90_000;

/** A realtime function tool, as the session config takes it. */
export interface RealtimeTool {
    type: "function";
    name: string;
    description: string;
    parameters: unknown;
}

/** The delegator's tools for one request; their definitions do not depend on it. */
function toolsFor(deps: DelegateDeps, viewed: string, tail: readonly string[], signal: AbortSignal, outcome: DelegateOutcome) {
    return voiceTools(deps, { viewed, instruction: "", tail, signal }, outcome);
}

/** The delegator's tools as realtime function definitions. */
export async function realtimeTools(): Promise<RealtimeTool[]> {
    // Only names, descriptions and schemas are read: nothing here runs.
    const tools = toolsFor({} as DelegateDeps, "", [], new AbortController().signal, {
        open: null,
        sent: [],
        explained: {}
    });
    return Promise.all(
        Object.entries(tools).map(async ([name, tool]) => ({
            type: "function" as const,
            name,
            description: typeof tool.description === "string" ? tool.description : "",
            parameters: await asSchema(tool.inputSchema).jsonSchema
        }))
    );
}

const mintAnswer = z.object({ value: z.string().min(1), expires_at: z.number() });

/**
 * A client secret for one realtime call, or null when OpenAI refused or did
 * not answer. The key is only sent to OpenAI and never returned.
 */
export async function mintRealtimeSecret(input: {
    apiKey: string;
    viewed: { id: string; title: string };
    lang: string | null;
    fetch?: typeof fetch;
}): Promise<RealtimeGrant | null> {
    const send = input.fetch ?? fetch;
    try {
        const response = await send(REALTIME_SECRETS_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                expires_after: { anchor: "created_at", seconds: SECRET_SECONDS },
                session: {
                    type: "realtime",
                    model: REALTIME_MODEL,
                    instructions: delegatorInstructions(input.viewed, [], input.lang),
                    audio: { output: { voice: REALTIME_VOICE } },
                    tools: await realtimeTools(),
                    tool_choice: "auto"
                }
            }),
            signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
            cache: "no-store"
        });
        if (!response.ok) {
            // The status only: OpenAI's error body may quote the request.
            console.warn(`polar: OpenAI refused a realtime client secret (${response.status})`);
            return null;
        }
        const parsed = mintAnswer.safeParse(await response.json());
        return parsed.success ? { value: parsed.data.value, expiresAt: parsed.data.expires_at } : null;
    } catch (error) {
        console.warn("polar: no realtime client secret", error instanceof Error ? error.name : "error");
        return null;
    }
}

function encode(value: unknown): string {
    const text = JSON.stringify(value ?? null);
    return text.length > OUTPUT_MAX ? JSON.stringify({ error: "The result was too long to read." }) : text;
}

/**
 * Runs one realtime tool call with the delegator's tools, defaulting to
 * `viewed`. A bad name or arguments are answered to the model as an error,
 * never thrown.
 */
export async function runRealtimeTool(input: {
    deps: DelegateDeps;
    viewed: string;
    name: string;
    arguments: string;
    tail: readonly string[];
    explained: Record<string, number>;
    signal: AbortSignal;
}): Promise<RealtimeToolAnswer> {
    const outcome: DelegateOutcome = { open: null, sent: [], explained: { ...input.explained } };
    const answer = (output: unknown): RealtimeToolAnswer => ({ output: encode(output), ...outcome });
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS)]);
    const tools = toolsFor(input.deps, input.viewed, input.tail, signal, outcome);
    const tool = Object.hasOwn(tools, input.name) ? tools[input.name] : undefined;
    if (!tool?.execute) return answer({ error: "There is no tool by that name." });
    let args: unknown;
    try {
        args = input.arguments.trim() ? JSON.parse(input.arguments) : {};
    } catch {
        return answer({ error: "The arguments were not JSON. Nothing was done." });
    }
    const checked = await asSchema(tool.inputSchema).validate?.(args);
    if (!checked?.success) return answer({ error: "The arguments do not fit the tool. Nothing was done." });
    const result = await tool.execute(checked.value, {
        toolCallId: "realtime",
        messages: [],
        abortSignal: signal,
        context: undefined
    });
    return answer(result);
}
