"use client";

/**
 * The subagents a Code session's agent launched, as a tree under the thread:
 * one row per launch with its description, type, status, duration and step
 * count, opened to the tool calls it made. Laid out after Claude Code's own
 * subagent view. Read from the session's hooks (`session-subagents.ts`), so it
 * follows the thread's own polling.
 */

import { useState } from "react";
import { Button, cn } from "@polaris/ui";
import { Bot, ChevronRight, Square } from "lucide-react";
import type { PolarCodeSubagent } from "@/lib/polar/code";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { durationOf, StatusMark, useNow } from "@/components/polar/polar-subagents";

const CARD = "flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3";

export function CodeSubagents({
    subagents,
    onStop,
    stopping = false
}: {
    subagents: readonly PolarCodeSubagent[];
    /** Stops the agent's turn, which is the only stop Claude Code offers for a
     *  subagent; null where this reader may not steer the session. */
    onStop: (() => void) | null;
    stopping?: boolean;
}) {
    const t = useTranslations("polar");
    const [open, setOpen] = useState(true);
    const running = subagents.filter((node) => node.status === "running").length;
    const now = useNow(running > 0);
    if (subagents.length === 0) return null;
    const summary = running > 0 ? t("subagents.panelRunning", { count: running }) : String(subagents.length);
    return (
        <section aria-label={t("subagents.title")} className={CARD}>
            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                aria-label={open ? t("code.subagents.hide") : t("code.subagents.show")}
                className="flex min-w-0 items-center gap-1.5 text-left text-sm font-medium"
            >
                <Bot className="size-4 shrink-0 text-primary" aria-hidden />
                <span className="truncate">{t("subagents.title")}</span>
                <span className="ml-auto min-w-0 max-w-full shrink-0 truncate text-xs font-normal text-muted-foreground" title={summary}>
                    {summary}
                </span>
                <ChevronRight className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
            </button>
            {open ? (
                <ul className="flex max-h-72 min-w-0 flex-col gap-1 overflow-y-auto overscroll-contain text-sm">
                    {subagents.map((node) => (
                        <SubagentRow key={node.id} node={node} now={now} onStop={onStop} stopping={stopping} />
                    ))}
                </ul>
            ) : null}
        </section>
    );
}

function SubagentRow({
    node,
    now,
    onStop,
    stopping
}: {
    node: PolarCodeSubagent;
    now: number;
    onStop: (() => void) | null;
    stopping: boolean;
}) {
    const t = useTranslations("polar");
    const [open, setOpen] = useState(false);
    const description = node.description || t("code.subagents.untitled");
    const status = t(`subagents.status.${node.status}`);
    const duration = node.startedAt === null ? null : durationOf(t, node.startedAt, node.endedAt, now);
    return (
        <li className="flex min-w-0 flex-col">
            <div className="flex min-w-0 items-center gap-1">
                <button
                    type="button"
                    onClick={() => setOpen((value) => !value)}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-card-hover [@media(pointer:coarse)]:min-h-11"
                >
                    <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />
                    <StatusMark status={node.status} />
                    <span className="sr-only">{status}</span>
                    <span className="min-w-0 truncate font-medium" title={description}>
                        {description}
                    </span>
                    <span className="max-w-[40%] shrink-0 truncate rounded bg-muted px-1.5 text-xs text-muted-foreground" title={node.type}>
                        {node.type}
                    </span>
                    <span className="ml-auto flex shrink-0 gap-2 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                        {duration ? <span>{duration}</span> : null}
                        <span>{t("subagents.steps", { count: node.steps.length })}</span>
                    </span>
                </button>
                {node.status === "running" && onStop ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={onStop}
                        disabled={stopping}
                        title={t("code.subagents.stopNote")}
                        aria-label={`${t("subagents.stop")}: ${t("code.subagents.stopNote")}`}
                        className="shrink-0 gap-1"
                    >
                        <Square className="size-3" aria-hidden />
                        {stopping ? t("subagents.stopping") : t("subagents.stop")}
                    </Button>
                ) : null}
            </div>
            {open ? (
                node.steps.length === 0 ? (
                    <p className="ml-7 py-1 text-xs text-muted-foreground">{t("code.subagents.noSteps")}</p>
                ) : (
                    <ol className="ml-7 flex min-w-0 flex-col gap-0.5 border-l border-border pl-2 text-xs">
                        {node.steps.map((step, index) => (
                            <li key={step.id ?? index} className="flex min-w-0 items-center gap-2">
                                <StatusMark status={step.status} />
                                <span className="sr-only">{t(`subagents.status.${step.status}`)}</span>
                                <span className="min-w-0 truncate" title={step.tool}>
                                    {step.tool}
                                </span>
                                {step.startedAt !== null && step.endedAt !== null ? (
                                    <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                                        {durationOf(t, step.startedAt, step.endedAt, now)}
                                    </span>
                                ) : null}
                            </li>
                        ))}
                    </ol>
                )
            ) : null}
        </li>
    );
}
