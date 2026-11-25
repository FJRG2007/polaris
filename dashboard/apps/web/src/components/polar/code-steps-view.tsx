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
import type { PolarCodeEntry } from "@/lib/polar/code";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { changeCodeSteps } from "@/components/polar/polar-display";
import { ThinkingOrb } from "@/components/polar/motion/thinking-orb";
import { CodeLine, CodeView, JsonView, isValidJson } from "@/components/json-view";

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
            // An ACP agent's title is the command in backticks.
            const command = input || step.name.replace(/^`|`$/g, "");
            const shown = command.split("\n", 1)[0]!.slice(0, 80);
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
    if (state === "running") return <ThinkingOrb state="solving" size={20} decorative />;
    const icon =
        state === "done" ? (
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

function StepInput({ step }: { step: steps.CodeToolStep }) {
    const t = useTranslations("polar");
    const input = step.input.trim();
    if (!input) return null;
    if (step.kind === "command")
        return <CodeView value={input} language="bash" className="max-h-40" label={t("code.step.command")} />;
    if (input.startsWith("{") && isValidJson(input))
        return <JsonView value={input} className="max-h-40" label={t("elements.parameters")} />;
    return (
        <p className="min-w-0 break-all rounded-md border border-border bg-muted/40 px-2 py-1">
            <CodeLine value={input} language="plaintext" className="text-[11px]" />
        </p>
    );
}

function StepOutput({ step }: { step: steps.CodeToolStep }) {
    const t = useTranslations("polar");
    const [all, setAll] = useState(false);
    const output = step.output.trimEnd();
    if (!output) {
        return step.state === "running" ? null : (
            <p className="text-[11px] text-foreground-subtle">{t("code.step.noOutput")}</p>
        );
    }
    const lines = output.split("\n");
    const clipped = !all && lines.length > OUTPUT_LINES;
    return (
        <div className="flex min-w-0 flex-col gap-1">
            {/* Logs have no grammar: plain text, as `CodeView` says. */}
            <pre
                className={cn(
                    "min-w-0 overflow-x-auto overscroll-contain whitespace-pre-wrap break-words rounded p-2 font-mono text-[11px]",
                    step.state === "failed" ? "bg-danger-soft text-danger-ink" : "bg-muted text-muted-foreground"
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
    const line = stepLine(t, step, view);
    return (
        <li className="min-w-0 list-none">
            <div className={cn("min-w-0 rounded-md", open && "border border-border bg-card")}>
                <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={id}
                    onClick={() => setOpen(!open)}
                    className={cn(
                        "flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-start hover:text-foreground",
                        open && "text-foreground"
                    )}
                >
                    {ICONS[step.kind]}
                    <span className="min-w-0 flex-1 truncate" title={line}>
                        {line}
                    </span>
                    {step.ms !== null && step.state !== "running" ? (
                        <span className="shrink-0 tabular-nums text-foreground-subtle">
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
