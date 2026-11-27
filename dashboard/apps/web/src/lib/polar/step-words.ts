/**
 * A tool call in words, the one way every surface says it - Polar Code's
 * thread, a subagent's steps, Polar's chat, an export: the verb in the tense
 * of the step's state ("Searching the web" while it runs, "Searched the web"
 * once done), the thing it acted on beside it, and a count of what it found.
 * The words come from the table in `code-steps.ts`, so a tool is said the
 * same everywhere. Pure and client-safe; takes the translator it is given.
 */

import * as steps from "@/lib/polar/code-steps";
import type { NamespaceTranslator } from "@/lib/i18n/types";

type Translate = NamespaceTranslator<"polar">;

/** Verbs said with a noun of their own when there is no target to name:
 *  "Read a file" rather than a bare "Read". */
const NEEDS_NOUN: ReadonlySet<steps.CodeStepVerb> = new Set([
    "command",
    "edit",
    "write",
    "delete",
    "read",
    "list",
    "webFetch"
]);

/** A step in words, the one way every surface says it: the verb in the
 *  tense of its state, the thing it acted on, and what it found. */
export interface StepWords {
    readonly label: string;
    readonly target: steps.StepTarget | null;
    readonly result: string | null;
}

/**
 * The words for a step, read from the one table (`code-steps.ts`): "Searching
 * the web" while it runs, "Searched the web" once done, with the query, file,
 * command or site beside it and a count of what came back ("12 matches"). A
 * tool the table does not know is said by its humanized name. Pure.
 */
export function stepWords(t: Translate, step: steps.CodeToolStep): StepWords {
    const verb = steps.verbOfStep(step);
    const running = step.state === "running";
    const found = steps.stepResult(step);
    const result = found === null ? null : found.key === "none" ? t("code.result.none") : t(`code.result.${found.key}`, { count: found.count });
    if (verb === "other" || verb === "meta") {
        const human = steps.humanToolName(step.name || "tool");
        const target = human.source ? { text: human.source, whole: human.source } : steps.stepTarget(step);
        return { label: human.label, target, result };
    }
    const target = steps.stepTarget(step);
    const tense = running ? "running" : "done";
    const label =
        target === null && NEEDS_NOUN.has(verb)
            ? t(`code.verb.${verb as NounVerb}.${tense}Any`)
            : t(`code.verb.${verb as SaidVerb}.${tense}`);
    return { label, target, result };
}

type SaidVerb = Exclude<steps.CodeStepVerb, "other" | "meta">;
type NounVerb = "command" | "edit" | "write" | "delete" | "read" | "list" | "webFetch";

/** A step as one line of text: "Read plan.ts", "Ran npm test". For the live
 *  line a folded turn shows, and for anything that cannot draw a chip. */
export function stepLine(t: Translate, step: steps.CodeToolStep): string {
    const { label, target } = stepWords(t, step);
    if (target === null) return label;
    return `${label} ${"code" in target ? target.code : "file" in target ? target.file : target.text}`;
}

/** The words for a fold of same-verb steps: "Read 3 files", "Searched the web
 *  4 times". A fold of edits to one file names that file. */
export function groupWords(t: Translate, verb: steps.CodeStepVerb, group: readonly steps.CodeToolStep[]): StepWords {
    const targets = group.map((step) => steps.stepTarget(step));
    const files = new Set(targets.flatMap((target) => (target && "file" in target ? [target.whole] : [])));
    const first = group[0]!;
    if (files.size === 1 && targets.every((target) => target && "file" in target)) {
        return { label: stepWords(t, first).label, target: targets[0]!, result: null };
    }
    const names = targets.flatMap((target) =>
        target === null ? [] : ["code" in target ? target.code : "file" in target ? target.file : target.text]
    );
    const unique = [...new Set(names)];
    const shown = unique.join(", ");
    const target = shown ? { text: shown, whole: unique.join("\n") } : null;
    const count = verb === "read" || verb === "edit" || verb === "write" ? Math.max(files.size, 1) : group.length;
    return { label: t(`code.group.${verb as GroupVerb}`, { count }), target, result: null };
}

type GroupVerb = "read" | "list" | "grep" | "glob" | "webSearch" | "webFetch" | "edit" | "write";

/** A step known only by its tool's name and state - a subagent's, an
 *  export's - in the same words as a thread's row. */
export function toolLine(t: Translate, name: string, state: steps.CodeStepState, input = ""): string {
    const kind = steps.stepKindOf(name);
    return stepLine(t, { name, kind, input, output: "", state, ms: null });
}

/** "8.5 s", for the hover of a row or a fold. */
export function stepTime(t: Translate, ms: number | null): string | null {
    return ms === null ? null : t("code.step.took", { seconds: Math.max(0.1, Math.round(ms / 100) / 10) });
}
