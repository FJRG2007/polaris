/**
 * The tips Polar shows under its busy line while it works, as Claude Code
 * shows one under its spinner ("Tip: Use /btw to ask a side question without
 * interrupting..."). Each names a command the surface really has, so a tip
 * never points at something that is not there; the words are
 * `polar.tips.<id>`.
 *
 * Client-safe: no server imports.
 */

import type { NamespaceKey } from "@/lib/i18n/types";
import type { CodeCommand } from "@/lib/polar/code-commands";
import type { ControlCommand } from "@/lib/polar/shared";

export type TipSurface = "chat" | "code";

type TipIdOf<K> = K extends `tips.${infer Id}` ? Id : never;

/** A tip's id, drawn from the `polar.tips` words, so a tip without them does not compile. */
export type TipId = Exclude<TipIdOf<NamespaceKey<"polar">>, "label">;

export type PolarTip =
    | { id: TipId; surface: "chat"; command: ControlCommand }
    | { id: TipId; surface: "code"; command: CodeCommand };

/** One list for every surface, in no particular order: one is picked at random. */
export const POLAR_TIPS: readonly PolarTip[] = [
    { id: "btw", surface: "chat", command: "btw" },
    { id: "recap", surface: "chat", command: "recap" },
    { id: "stop", surface: "chat", command: "stop" },
    { id: "goal", surface: "chat", command: "goal" },
    { id: "compact", surface: "chat", command: "compact" },
    { id: "context", surface: "chat", command: "context" },
    { id: "branch", surface: "chat", command: "branch" },
    { id: "temp", surface: "chat", command: "temp" },
    { id: "resume", surface: "chat", command: "resume" },
    { id: "export", surface: "chat", command: "export" },
    { id: "codePlan", surface: "code", command: "plan" },
    { id: "codeDiff", surface: "code", command: "diff" },
    { id: "codeContext", surface: "code", command: "context" },
    { id: "codeGoal", surface: "code", command: "goal" },
    { id: "codeStop", surface: "code", command: "stop" },
    { id: "codeNew", surface: "code", command: "new" },
    { id: "codeExport", surface: "code", command: "export" }
];

export function tipsFor(surface: TipSurface): PolarTip[] {
    return POLAR_TIPS.filter((tip) => tip.surface === surface);
}

/** One tip for this wait, picked with `random` (0 <= n < 1). */
export function pickTip(surface: TipSurface, random: number = Math.random()): PolarTip | null {
    const list = tipsFor(surface);
    if (list.length === 0) return null;
    return list[Math.min(list.length - 1, Math.floor(random * list.length))] ?? null;
}
