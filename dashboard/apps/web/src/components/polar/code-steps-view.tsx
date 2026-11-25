"use client";

/**
 * The agent's work in a Polar Code thread, the way Claude Code on the web,
 * Cursor and Codex show theirs: one line per step that says what it is doing,
 * and each step opening into what it ran and what came back. "compact" keeps
 * the lines and hides the code until a step is opened; "detailed" opens every
 * card. Both are the person's pick (`code-steps.ts`), changed here or in
 * Polar's settings, and remembered on their account.
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
import { CopyButton } from "@/components/copy-button";
import type { PolarCodeEntry } from "@/lib/polar/code";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { changeCodeSteps } from "@/components/polar/polar-display";
import { ThinkingOrb } from "@/components/polar/motion/thinking-orb";
import { CodeLine, JsonView, isValidJson } from "@/components/json-view";

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

/** What a step is doing, in plain words: "Editing plan.ts", "Running a
 *  command". A developer's view names the command itself. */
export function stepLine(t: Translate, step: steps.CodeToolStep, view: steps.CodeStepView): string {
    const input = step.input.trim();
    const path = input && !input.startsWith("{") && !/\s/.test(input) ? steps.baseName(input) : "";
    const running = step.state === "running";
    switch (step.kind) {
        case "command": {
            const shown = steps.stepCommand(step).split("\n", 1)[0]!.slice(0, 80);
            if (view === "detailed" && shown)
                return t(running ? "code.step.runningCommand" : "code.step.ranCommand", { command: shown });
            return t(running ? "code.step.runningAny" : "code.step.ranAny");
        }
        case "edit":
            return path
                ? t(running ? "code.step.editing" : "code.step.edited", { file: path })
                : t(running ? "code.step.editingAny" : "code.step.editedAny");
        case "read":
            return path
                ? t(running ? "code.step.reading" : "code.step.read", { file: path })
                : t(running ? "code.step.readingAny" : "code.step.readAny");
        case "search":
            return t(running ? "code.step.searching" : "code.step.searched");
        case "web":
            return t(running ? "code.step.browsing" : "code.step.browsed");
        case "task":
            return t(running ? "code.step.delegating" : "code.step.delegated");
        default:
            return t(running ? "code.step.using" : "code.step.used", { tool: step.name || "tool" });
    }
}

/** What a step card's line shows beside its words: the command it ran, or the
 *  file it touched. */
export type StepDetail = { readonly code: string } | { readonly file: string; readonly path: string } | null;

/** A path a step was called with, when its input is one. */
function pathOf(step: steps.CodeToolStep): string {
    const input = step.input.trim();
    return (step.kind === "read" || step.kind === "edit") && input && !input.startsWith("{") && !/\s/.test(input)
        ? input
        : "";
}

/**
 * A step card's line: a short verb with the command or the file beside it.
 * The command shows there only while the card is closed in the developer's
 * view - opened, the card shows it whole, so it is never said twice. Pure.
 */
export function stepHead(
    t: Translate,
    step: steps.CodeToolStep,
    view: steps.CodeStepView,
    open: boolean
): { label: string; detail: StepDetail } {
    const running = step.state === "running";
    if (step.kind === "command") {
        const command = steps.stepCommand(step);
        if (view === "detailed" && !open && command) {
            return {
                label: t(running ? "code.step.runningVerb" : "code.step.ranVerb"),
                detail: { code: command.split("\n", 1)[0]! }
            };
        }
        return { label: stepLine(t, step, "compact"), detail: null };
    }
    const path = pathOf(step);
    if (path) {
        const verb =
            step.kind === "read"
                ? running
                    ? "code.step.readingVerb"
                    : "code.step.readVerb"
                : running
                  ? "code.step.editingVerb"
                  : "code.step.editedVerb";
        return { label: t(verb), detail: { file: steps.baseName(path), path } };
    }
    return { label: stepLine(t, step, view), detail: null };
}

/** "12 steps: 4 commands, 3 edits" for a finished turn's folded line. */
export function stepsSummary(t: Translate, entries: readonly PolarCodeEntry[]): string {
    const tools = entries.flatMap((entry) => (entry.step ? [entry.step] : []));
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
 *  and copyable. */
function CommandBlock({ command }: { command: string }) {
    const t = useTranslations("polar");
    return (
        <div className="group relative flex min-w-0 items-start gap-2 rounded bg-muted/50 py-1.5 pe-8 ps-2 text-[11px] leading-relaxed">
            <span className="shrink-0 select-none font-mono text-foreground-subtle" aria-hidden>
                $
            </span>
            <div className="max-h-40 min-w-0 flex-1 overflow-y-auto overscroll-contain">
                <CodeLine value={command} language="bash" className="block whitespace-pre-wrap break-all" />
            </div>
            <CopyButton
                value={command}
                label={t("code.step.command")}
                className="absolute end-1 top-1 transition-opacity focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
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
    const path = pathOf(step);
    if (path && steps.baseName(path) === path) return null;
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

/** One step: its line, and under it what went in and what came back. */
export function CodeStepCard({ step, view }: { step: steps.CodeToolStep; view: steps.CodeStepView }) {
    const t = useTranslations("polar");
    const id = useId();
    const [open, setOpen] = useState(view === "detailed");
    // Expand all / collapse all wins over a click made before it.
    useEffect(() => setOpen(view === "detailed"), [view]);
    const { label, detail } = stepHead(t, step, view, open);
    // A line cut short by the width says itself whole on hover.
    const whole = detail === null ? label : "code" in detail ? `${label} ${detail.code}` : `${label} ${detail.path}`;
    return (
        <li className="min-w-0 list-none">
            <div className={cn("min-w-0 rounded-md border", open ? "border-border bg-background" : "border-transparent")}>
                <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={id}
                    onClick={() => setOpen(!open)}
                    title={whole}
                    className={cn(
                        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-start hover:bg-card-hover hover:text-foreground [@media(pointer:coarse)]:min-h-11",
                        open && "text-foreground"
                    )}
                >
                    {ICONS[step.kind]}
                    <span className={cn("min-w-0 truncate", detail === null ? "flex-1" : "max-w-[45%] shrink-0")}>
                        {label}
                    </span>
                    {detail === null ? null : "code" in detail ? (
                        <span className="min-w-0 flex-1 truncate text-[11px]">
                            <CodeLine value={detail.code} language="bash" />
                        </span>
                    ) : (
                        <span className="flex min-w-0 flex-1">
                            <span className="min-w-0 truncate rounded bg-muted px-1.5 font-mono text-[11px] text-foreground">
                                {detail.file}
                            </span>
                        </span>
                    )}
                    {step.ms !== null && step.state !== "running" ? (
                        <span className="shrink-0 text-[11px] tabular-nums text-foreground-subtle">
                            {t("code.step.took", { seconds: Math.max(0.1, Math.round(step.ms / 100) / 10) })}
                        </span>
                    ) : null}
                    <StateMark state={step.state} />
                    <ChevronDown
                        className={cn(
                            "h-3.5 w-3.5 shrink-0 text-foreground-subtle transition-transform duration-fast",
                            open && "rotate-180"
                        )}
                        aria-hidden
                    />
                </button>
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
