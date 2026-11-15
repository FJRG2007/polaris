/**
 * How hard a Polar Chat model thinks: which steps of the intelligence axis the
 * picked model offers, and what each step becomes on its provider's own wire.
 *
 * The composer's pill reads `effortControl` to show only the steps a model
 * publishes; the router (`router/chain.ts`) calls `effortCallOptions` on every
 * step, so a fallback on another provider gets that provider's parameter. One
 * function per provider; a provider without one keeps the AI SDK's own
 * translation of the neutral `reasoning` option.
 *
 * Parameter names, read 2026-11-15:
 * - Anthropic `output_config.effort` (`low` .. `max`, per model; `xhigh` and
 *   `max` not on every model): https://platform.claude.com/docs/en/build-with-claude/effort
 * - OpenAI `reasoning_effort` (Chat) / `reasoning.effort` (Responses), values
 *   per model: https://developers.openai.com/api/docs/guides/reasoning
 * - Google `thinking_level` (`minimal`, `low`, `medium`, `high`, per model):
 *   https://aistudio.google.com/docs/thinking
 * - DeepSeek `thinking: {type: "enabled" | "disabled"}` plus `reasoning_effort`
 *   (`low`, `high`, `max`): https://api-docs.deepseek.com/guides/thinking_mode
 *
 * Client-safe and pure.
 */

import type { SdkReasoning } from "@/lib/polar/routing";
import { INTELLIGENCE_LEVELS, type Intelligence } from "@/lib/polar/shared";

/** The fields of a model the effort decision reads. */
export interface EffortModel {
    provider: string;
    model: string;
    reasoning: boolean;
}

/** What the composer shows: nothing, an on/off "Think" toggle, or the steps
 *  the model offers, ascending. */
export type EffortControl =
    | { kind: "none" }
    | { kind: "toggle" }
    | { kind: "ladder"; levels: readonly Intelligence[] };

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
/** Provider options keyed by the provider's AI SDK name. */
export type EffortOptions = Record<string, Record<string, Json>>;

/** The neutral level each intelligence step sends (`models.ts`). */
const NEUTRAL: Readonly<Record<Intelligence, SdkReasoning>> = {
    fast: "low",
    balanced: "medium",
    deep: "high",
    max: "xhigh"
};

/** A provider's own effort mapping. `rungs` lists, per intelligence step, the
 *  provider value it becomes; a step absent from it is not offered. */
interface ProviderEffort {
    rungs(model: string): Partial<Record<Intelligence, string>> | null;
    options(model: string, rung: string): EffortOptions;
}

/**
 * Anthropic: `effort` on models with adaptive thinking (the AI SDK's
 * `anthropic.effort` is `output_config.effort`). Opus 4.5 and older thinking
 * models keep the SDK's own budget translation (null here).
 */
export function anthropicRungs(model: string): Partial<Record<Intelligence, string>> | null {
    const id = model.toLowerCase();
    const all = { fast: "low", balanced: "medium", deep: "high", max: "xhigh" };
    const noXhigh = { fast: "low", balanced: "medium", deep: "high", max: "max" };
    if (/mythos-preview/.test(id)) return noXhigh;
    const match = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id);
    if (!match) return null;
    const [, family, majorText, minorText] = match;
    const major = Number(majorText);
    const minor = minorText === undefined ? 0 : Number(minorText);
    if (family === "fable" || family === "mythos") return major >= 5 ? all : null;
    if (major >= 5) return family === "haiku" && major === 5 && minor < 5 ? null : all;
    if (major === 4 && family === "opus" && minor >= 7) return all;
    if (major === 4 && minor === 6 && (family === "opus" || family === "sonnet")) return noXhigh;
    return null;
}

const anthropic: ProviderEffort = {
    rungs: anthropicRungs,
    options: (_model, rung) => ({
        anthropic: { effort: rung, thinking: { type: "adaptive", display: "summarized" } }
    })
};

/** OpenAI: `reasoningEffort` is the SDK's `reasoning_effort`. Only the three
 *  levels every reasoning model has; `none`, `minimal` and `xhigh` vary by
 *  model and the docs do not list which. */
const openai: ProviderEffort = {
    rungs: () => ({ fast: "low", balanced: "medium", deep: "high" }),
    options: (_model, rung) => ({ openai: { reasoningEffort: rung } })
};

/** Google: `thinkingConfig.thinkingLevel` on Gemini 3 and 2.5; Gemini 3 Pro
 *  Preview has only `low` and `high`. Other models keep the SDK's mapping. */
export function googleRungs(model: string): Partial<Record<Intelligence, string>> | null {
    const id = model.toLowerCase();
    if (/gemini-3-pro-preview/.test(id)) return { fast: "low", deep: "high" };
    if (/gemini-(3|2\.5)/.test(id)) return { fast: "low", balanced: "medium", deep: "high" };
    return null;
}

const google: ProviderEffort = {
    rungs: googleRungs,
    options: (_model, rung) => ({ google: { thinkingConfig: { thinkingLevel: rung, includeThoughts: true } } })
};

/** DeepSeek: thinking is a switch, so `fast` is off and every other step is
 *  on at the API's default `high`. */
const deepseek: ProviderEffort = {
    rungs: () => ({ fast: "off", deep: "high" }),
    options: (_model, rung): EffortOptions =>
        rung === "off"
            ? { deepseek: { thinking: { type: "disabled" } } }
            : { deepseek: { thinking: { type: "enabled" }, reasoningEffort: rung } }
};

const PROVIDERS: Readonly<Record<string, ProviderEffort>> = { anthropic, openai, "google-ai": google, deepseek };

/** Whether this model's thinking is an on/off switch rather than a ladder. */
function isToggle(model: EffortModel): boolean {
    return model.provider === "deepseek";
}

/** What the composer offers for this model. Pure. */
export function effortControl(model: EffortModel | null | undefined): EffortControl {
    if (!model?.reasoning) return { kind: "none" };
    if (isToggle(model)) return { kind: "toggle" };
    const rungs = PROVIDERS[model.provider]?.rungs(model.model) ?? null;
    if (!rungs) return { kind: "ladder", levels: INTELLIGENCE_LEVELS };
    return { kind: "ladder", levels: INTELLIGENCE_LEVELS.filter((level) => rungs[level] !== undefined) };
}

/**
 * The step a stored level lands on for this control: itself when offered, else
 * the highest offered step below it, else the lowest offered. A toggle keeps
 * `fast` (off) or reads anything else as on (`deep`). Pure.
 */
export function clampIntelligence(level: Intelligence, control: EffortControl): Intelligence {
    if (control.kind === "none") return level;
    if (control.kind === "toggle") return level === "fast" ? "fast" : "deep";
    if (control.levels.includes(level)) return level;
    const rank = INTELLIGENCE_LEVELS.indexOf(level);
    const below = control.levels.filter((step) => INTELLIGENCE_LEVELS.indexOf(step) < rank);
    return below.at(-1) ?? control.levels[0] ?? level;
}

/** The intelligence step a neutral level came from, for the router, which
 *  only sees the neutral one. */
function stepOf(reasoning: SdkReasoning): Intelligence {
    if (reasoning === "none" || reasoning === "low") return "fast";
    if (reasoning === "medium") return "balanced";
    if (reasoning === "high") return "deep";
    return "max";
}

/**
 * What one call to this model carries for this neutral level: the provider's
 * own option, clamped to a step the model offers, or nothing when the model
 * does not reason or its provider keeps the SDK's translation. Pure.
 */
export function effortCallOptions(
    model: EffortModel,
    reasoning: SdkReasoning | undefined
): { reasoning: SdkReasoning | undefined; providerOptions?: EffortOptions } {
    if (reasoning === undefined) return { reasoning };
    const provider = PROVIDERS[model.provider];
    const control = effortControl(model);
    const rungs = provider?.rungs(model.model) ?? null;
    if (!provider || !rungs || control.kind === "none") return { reasoning };
    const step = clampIntelligence(stepOf(reasoning), control);
    const rung = rungs[step];
    if (rung === undefined) return { reasoning };
    // The neutral option goes too, at the clamped step, except for a switch
    // turned off: the provider option is then the whole answer.
    return {
        reasoning: rung === "off" ? undefined : NEUTRAL[step],
        providerOptions: provider.options(model.model, rung)
    };
}

/** Provider options merged one provider deep: the effort's keys win, the
 *  call's other keys (cache control) stay. Pure. */
export function mergeProviderOptions<T extends Record<string, Record<string, unknown>> | undefined>(
    base: T,
    extra: EffortOptions | undefined
): T {
    if (!extra) return base;
    const merged: Record<string, Record<string, unknown>> = { ...(base ?? {}) };
    for (const [provider, values] of Object.entries(extra)) {
        merged[provider] = { ...(merged[provider] ?? {}), ...values };
    }
    return merged as T;
}

/** Most models one person's remembered levels hold. */
const REMEMBERED_MOST = 50;

/** One person's last level per model, keyed `provider/model`. */
export type EffortMemory = Record<string, Intelligence>;

function memoryKey(choice: { provider: string; model: string }): string {
    return `${choice.provider}/${choice.model}`;
}

/** Reads stored memory, dropping anything that is not a level. Pure. */
export function readEffortMemory(raw: string | null): EffortMemory {
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>).filter(
                (entry): entry is [string, Intelligence] =>
                    typeof entry[1] === "string" && (INTELLIGENCE_LEVELS as readonly string[]).includes(entry[1])
            )
        );
    } catch {
        return {};
    }
}

/** The memory with this model's level set last, oldest dropped past the cap. Pure. */
export function rememberEffort(
    memory: EffortMemory,
    choice: { provider: string; model: string; intelligence: Intelligence }
): EffortMemory {
    const key = memoryKey(choice);
    const { [key]: _old, ...rest } = memory;
    const entries = [...Object.entries(rest), [key, choice.intelligence] as const];
    return Object.fromEntries(entries.slice(-REMEMBERED_MOST));
}

/** The level last used on this model, or null when none is remembered. Pure. */
export function recallEffort(memory: EffortMemory, choice: { provider: string; model: string }): Intelligence | null {
    return memory[memoryKey(choice)] ?? null;
}
