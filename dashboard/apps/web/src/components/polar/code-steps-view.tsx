"use client";

/**
 * The agent's work in a Polar Code thread, the way Claude Code on the web,
 * Cursor and Codex show theirs: one line per step that says what it is doing,
 * and each step opening into what it ran and what came back. Every row says
 * its verb in the tense of its state, the thing it acted on and what it found,
 * from the one table in `code-steps.ts`; same-verb rows in a row fold into one.
 * "compact" keeps the rows closed; "detailed" opens every card. Both are the
 * person's pick (`code-steps.ts`), changed here or in Polar's settings, and
 * remembered on their account.
 */

import { cn } from "@polaris/ui";
import { useEffect, useId, useState, type ReactNode } from "react";
import {
    Bot,
    CheckCircle2,
    ChevronDown,
    CircleSlash,
    FilePen,
    FileText,
    Globe,
    Search,
    SquareTerminal,
    Wrench,
    XCircle
} from "lucide-react";
import * as steps from "@/lib/polar/code-steps";
import { groupWords, stepTime, stepWords, type StepWords } from "@/lib/polar/step-words";
import { CopyButton } from "@/components/copy-button";
import type { PolarCodeEntry } from "@/lib/polar/code";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { changeCodeSteps } from "@/components/polar/polar-display";
import { ThinkingOrb } from "@/components/polar/motion/thinking-orb";
import { CodeLine, JsonView, isValidJson } from "@/components/json-view";

export { stepLine, toolLine } from "@/lib/polar/step-words";

type Translate = NamespaceTranslator<"polar">;

const ICONS: Record<steps.CodeStepKind, ReactNode> = {
    command: <SquareTerminal className="h-3.5 w-3.5 shrink-0" aria-hidden />,
    edit: <FilePen className="h-3.5 w-3.5 shrink-0" aria-hidden />,
    read: <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />,
    search: <Search className="h-3.5 w-3.5 shrink-0" aria-hidden />,
    web: <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden />,
    task: <Bot className="h-3.5 w-3.5 shrink-0" aria-hidden />,
    other: <Wrench className="h-3.5 w-3.5 shrink-0" aria-hidden />
};

/** Output longer than this many lines is clipped until "Show all". */
const OUTPUT_LINES = 12;

/** "12 steps: 4 commands, 3 edits" for a finished turn's folded line. */
export function stepsSummary(t: Translate, entries: readonly PolarCodeEntry[]): string {
    const tools = entries.flatMap((entry) => (entry.step && !steps.isHiddenStep(entry.step) ? [entry.step] : []));
    if (tools.length === 0) return t("code.steps", { count: entries.length });
    const parts = steps
        .stepCounts(tools)
        .map(({ kind, count }) => t(`code.stepKinds.${kind as Exclude<steps.CodeStepKind, "other">}`, { count }));
    return parts.length > 0
        ? t("code.stepsOf", { count: tools.length, parts: parts.join(", ") })
        : t("code.steps", { count: tools.length });
}

function StateMark({ state }: { state: steps.CodeStepState }) {
    const t = useTranslations("polar");
    const label = t(`code.stepState.${state}`);
    const icon =
        state === "running" ? (
            <ThinkingOrb state="solving" size={20} decorative />
        ) : state === "done" ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-success-ink" aria-hidden />
        ) : state === "failed" ? (
            <XCircle className="h-3.5 w-3.5 text-danger-ink" aria-hidden />
        ) : (
            <CircleSlash className="h-3.5 w-3.5 text-foreground-subtle" aria-hidden />
        );
    return (
        <span className="inline-flex shrink-0 items-center" title={label}>
            {icon}
            <span className="sr-only">{label}</span>
        </span>
    );
}

/** The command a step ran, whole: painted as shell, wrapped rather than cut,
 *  and copyable. The copy button is a column of its own, so a long command's
 *  scrollbar and the button never sit on top of each other. */
function CommandBlock({ command }: { command: string }) {
    const t = useTranslations("polar");
    return (
        <div className="group flex min-w-0 items-start gap-2 rounded bg-muted/50 py-1.5 pe-1 ps-2 text-[11px] leading-relaxed">
            <span className="shrink-0 select-none font-mono text-foreground-subtle" aria-hidden>
                $
            </span>
            <div className="max-h-40 min-w-0 flex-1 overflow-y-auto overscroll-contain">
                <CodeLine value={command} language="bash" className="block whitespace-pre-wrap break-all" />
            </div>
            <CopyButton
                value={command}
                label={t("code.step.command")}
                className="-my-0.5 shrink-0 transition-opacity focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
            />
        </div>
    );
}

function StepInput({ step }: { step: steps.CodeToolStep }) {
    const t = useTranslations("polar");
    if (step.kind === "command") {
        const command = steps.stepCommand(step);
        return command ? <CommandBlock command={command} /> : null;
    }
    const input = step.input.trim();
    if (!input) return null;
    if (input.startsWith("{") && isValidJson(input))
        return <JsonView value={input} className="max-h-40" label={t("elements.parameters")} />;
    // The file's name is on the step's line; its whole path is said here only
    // when there is more of it than the name.
    const target = steps.stepTarget(step);
    if (target && "file" in target && target.file === target.whole) return null;
    return (
        <p className="min-w-0 break-all rounded bg-muted/50 px-2 py-1.5">
            <CodeLine value={input} language="plaintext" className="text-[11px]" />
        </p>
    );
}

function StepOutput({ step }: { step: steps.CodeToolStep }) {
    const t = useTranslations("polar");
    const [all, setAll] = useState(false);
    const output = steps.stepOutputText(step.output);
    if (!output) {
        return step.state === "running" ? null : (
            <p className="px-2 text-[11px] text-foreground-subtle">{t("code.step.noOutput")}</p>
        );
    }
    const lines = output.split("\n");
    const clipped = !all && lines.length > OUTPUT_LINES;
    return (
        <div className="flex min-w-0 flex-col gap-1">
            {/* Logs have no grammar: plain text, as `CodeView` says. */}
            <pre
                aria-label={t("code.step.output")}
                className={cn(
                    "max-h-96 min-w-0 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded px-2 py-1.5 font-mono text-[11px] leading-relaxed",
                    step.state === "failed" ? "bg-danger-soft text-danger-ink" : "bg-muted/50 text-muted-foreground"
                )}
            >
                {clipped ? lines.slice(0, OUTPUT_LINES).join("\n") : output}
            </pre>
            {lines.length > OUTPUT_LINES ? (
                <button
                    type="button"
                    onClick={() => setAll(!all)}
                    className="self-start rounded px-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                    {all ? t("code.step.showLess") : t("code.step.showAll", { count: lines.length })}
                </button>
            ) : null}
        </div>
    );
}

/** The thing a row acted on, beside its words: a command or pattern painted
 *  as code, a file as a chip, a query or a site as text. Cut by the width. */
function TargetMark({ target }: { target: steps.StepTarget; }) {
    if ("code" in target) {
        return (
            <span className="min-w-0 flex-1 truncate text-[11px]">
                <CodeLine value={target.code} language="bash" />
            </span>
        );
    }
    if ("file" in target) {
        return (
            <span className="flex min-w-0 flex-1">
                <span className="min-w-0 truncate rounded bg-muted px-1.5 font-mono text-[11px] text-foreground">
                    {target.file}
                </span>
            </span>
        );
    }
    return <span className="min-w-0 flex-1 truncate text-foreground-subtle">{target.text}</span>;
}

/** A row's hover: every word of it, whole, and how long it took. */
function rowTitle(words: StepWords, time: string | null): string {
    return [words.label, words.target?.whole, words.result, time].filter(Boolean).join(" - ");
}

/** The line a step or a fold opens from: its icon, its words, what it acted
 *  on and what it found. */
function StepRow({
    icon,
    words,
    title,
    open,
    controls,
    onToggle,
    state
}: {
    icon: ReactNode;
    words: StepWords;
    title: string;
    open: boolean;
    controls: string;
    onToggle: () => void;
    state: steps.CodeStepState;
}) {
    return (
        <button
            type="button"
            aria-expanded={open}
            aria-controls={controls}
            onClick={onToggle}
            title={title}
            className={cn(
                "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-start hover:bg-card-hover hover:text-foreground [@media(pointer:coarse)]:min-h-11",
                open && "text-foreground"
            )}
        >
            {icon}
            <span className={cn("min-w-0 truncate", words.target === null ? "flex-1" : "max-w-[45%] shrink-0")}>
                {words.label}
            </span>
            {words.target === null ? null : <TargetMark target={words.target} />}
            {words.result ? (
                <span className="shrink-0 text-[11px] tabular-nums text-foreground-subtle">{words.result}</span>
            ) : null}
            <StateMark state={state} />
            <ChevronDown
                className={cn(
                    "h-3.5 w-3.5 shrink-0 text-foreground-subtle transition-transform duration-fast",
                    open && "rotate-180"
                )}
                aria-hidden
            />
        </button>
    );
}

/** One step: its line, and under it what went in and what came back. */
export function CodeStepCard({ step, view }: { step: steps.CodeToolStep; view: steps.CodeStepView; }) {
    const t = useTranslations("polar");
    const id = useId();
    const [open, setOpen] = useState(view === "detailed");
    // Expand all / collapse all wins over a click made before it.
    useEffect(() => setOpen(view === "detailed"), [view]);
    const words = stepWords(t, step);
    // Opened, the card shows the command whole, so the line does not say it twice.
    const shown = open && words.target && "code" in words.target && steps.verbOfStep(step) === "command"
        ? { ...words, target: null }
        : words;
    return (
        <li className="min-w-0 list-none">
            <div className={cn("min-w-0 rounded-md border", open ? "border-border bg-background" : "border-transparent")}>
                <StepRow
                    icon={ICONS[step.kind]}
                    words={shown}
                    title={rowTitle(words, step.state === "running" ? null : stepTime(t, step.ms))}
                    open={open}
                    controls={id}
                    onToggle={() => setOpen(!open)}
                    state={step.state}
                />
                {open ? (
                    <div id={id} className="flex min-w-0 flex-col gap-2 border-t border-border p-2">
                        <StepInput step={step} />
                        <StepOutput step={step} />
                    </div>
                ) : null}
            </div>
        </li>
    );
}

/** Several steps of one verb in a row, folded into one line ("Read 3 files")
 *  that opens into each of them. */
export function CodeStepGroup({
    verb,
    group,
    view
}: {
    verb: steps.CodeStepVerb;
    group: readonly steps.CodeToolStep[];
    view: steps.CodeStepView;
}) {
    const t = useTranslations("polar");
    const id = useId();
    const [open, setOpen] = useState(view === "detailed");
    useEffect(() => setOpen(view === "detailed"), [view]);
    const words = groupWords(t, verb, group);
    const timed = group.flatMap((step) => (step.ms === null ? [] : [step.ms]));
    const total = timed.length > 0 ? timed.reduce((sum, ms) => sum + ms, 0) : null;
    return (
        <li className="min-w-0 list-none">
            <StepRow
                icon={ICONS[group[0]!.kind]}
                words={words}
                title={rowTitle(words, stepTime(t, total))}
                open={open}
                controls={id}
                onToggle={() => setOpen(!open)}
                state="done"
            />
            {open ? (
                <ol id={id} className="ms-4 flex min-w-0 flex-col gap-1 border-s border-border ps-2">
                    {group.map((step, index) => (
                        <CodeStepCard key={index} step={step} view={view} />
                    ))}
                </ol>
            ) : null}
        </li>
    );
}

/** The session-level switch: every step open, or every step a line. Saved
 *  for the person, so the next session opens the same way. */
export function StepsToggle({ view }: { view: steps.CodeStepView }) {
    const t = useTranslations("polar");
    const next: steps.CodeStepView = view === "detailed" ? "compact" : "detailed";
    const label = view === "detailed" ? t("code.step.collapseAll") : t("code.step.expandAll");
    return (
        <button
            type="button"
            onClick={() => void changeCodeSteps(next)}
            aria-label={label}
            title={label}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-card-hover hover:text-foreground [@media(pointer:coarse)]:h-11"
        >
            <ChevronDown className={cn("h-3.5 w-3.5", view === "detailed" && "rotate-180")} aria-hidden />
            <span className="max-sm:sr-only">{label}</span>
        </button>
    );
}

/** Asked once, while the person has not picked: words only, or the code too. */
export function StepsOffer() {
    const t = useTranslations("polar");
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
            <p className="min-w-0 flex-1 basis-48 text-muted-foreground">{t("code.step.offer")}</p>
            <button
                type="button"
                onClick={() => void changeCodeSteps("compact")}
                className="rounded-md border border-border px-2 py-1 text-foreground hover:bg-card-hover"
            >
                {t("settings.codeSteps.names.compact")}
            </button>
            <button
                type="button"
                onClick={() => void changeCodeSteps("detailed")}
                className="rounded-md border border-border px-2 py-1 text-foreground hover:bg-card-hover"
            >
                {t("settings.codeSteps.names.detailed")}
            </button>
        </div>
    );
}
