"use client";

/**
 * The list of rules and the log of their runs, as every rule builder draws
 * them: a rule's on/off switch, its name and what it does, how its last run
 * went and when, and its actions; a run's outcome, why it fired and when, with
 * its detail folded under it.
 *
 * Nothing here knows what a rule is. Every word, the link a name opens and the
 * time an outcome is read at arrive as props, already in the reader's language.
 */

import { cn } from "../lib/cn";
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { Switch } from "../components/switch";

/** How an outcome reads at a glance. */
export type RuleTone = "success" | "active" | "warning" | "danger" | "muted";

const TONES: Readonly<Record<RuleTone, string>> = {
    success: "border-success-edge bg-success-soft text-success-ink",
    active: "border-accent/30 bg-accent/10 text-accent",
    warning: "border-warning-edge bg-warning-soft text-warning-ink",
    danger: "border-danger-edge bg-danger-soft text-danger-ink",
    muted: "border-border bg-muted text-muted-foreground"
};

/** A tone as a chip's colours. */
export function ruleToneClass(tone: RuleTone): string {
    return TONES[tone];
}

/** An outcome: the word, in its tone. */
export interface RuleOutcome {
    readonly text: string;
    readonly tone: RuleTone;
}

export function OutcomeBadge({ outcome, className }: { outcome: RuleOutcome; className?: string }) {
    return <Badge className={cn("shrink-0", TONES[outcome.tone], className)}>{outcome.text}</Badge>;
}

export function RuleList({ label, children }: { label?: string; children: ReactNode }) {
    return (
        <ul aria-label={label} className="flex flex-col gap-2">
            {children}
        </ul>
    );
}

/** What opens a rule from its name: a link or a button, drawn by the caller. */
export type RuleOpener = (props: { className: string; children: ReactNode }) => ReactNode;

/**
 * One rule in the list: switched on or off where it stands, opened from its
 * name, its last run, and its actions at the end.
 */
export function RuleRow({
    name,
    summary,
    enabled,
    onToggle,
    toggleLabel,
    toggleDisabled,
    open,
    last,
    lastRun,
    neverRan,
    detail,
    actions
}: {
    name: string;
    /** What the rule does, in one line. */
    summary: ReactNode;
    enabled: boolean;
    onToggle: (enabled: boolean) => void;
    toggleLabel: string;
    toggleDisabled?: boolean;
    open?: RuleOpener;
    /** How the last run went; none when it never ran. */
    last?: RuleOutcome | null;
    /** When it last ran, as the caller reads a time. */
    lastRun?: ReactNode;
    neverRan: string;
    /** A line under the summary that needs the reader: a failure, a next run. */
    detail?: ReactNode;
    actions?: ReactNode;
}) {
    const body = (
        <>
            <span
                className={cn("truncate text-sm font-medium", !enabled && "text-muted-foreground")}
                title={name}
            >
                {name}
            </span>
            <span className="truncate text-[0.6875rem] text-foreground-subtle">{summary}</span>
        </>
    );
    const bodyClass = "flex min-w-0 flex-1 flex-col gap-0.5 text-left";
    return (
        <li className="flex flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Switch
                    checked={enabled}
                    disabled={toggleDisabled}
                    onChange={onToggle}
                    aria-label={toggleLabel}
                />
                {open ? open({ className: bodyClass, children: body }) : <div className={bodyClass}>{body}</div>}
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    {last ? (
                        <>
                            <OutcomeBadge outcome={last} />
                            {lastRun}
                        </>
                    ) : (
                        neverRan
                    )}
                </span>
                {actions && <span className="flex shrink-0 items-center gap-1">{actions}</span>}
            </div>
            {detail && <div className="min-w-0 break-words text-xs [overflow-wrap:anywhere]">{detail}</div>}
        </li>
    );
}

/** An icon button at the end of a rule or a run. */
export function RuleAction({
    label,
    title,
    disabled,
    onClick,
    asChild,
    children
}: {
    label: string;
    title?: string;
    disabled?: boolean;
    onClick?: () => void;
    asChild?: boolean;
    children: ReactNode;
}) {
    return (
        <Button
            asChild={asChild}
            size="sm"
            variant="ghost"
            className="size-8 shrink-0 p-0"
            disabled={disabled}
            aria-label={label}
            title={title ?? label}
            onClick={onClick}
        >
            {children}
        </Button>
    );
}

export function RunList({ label, children }: { label?: string; children: ReactNode }) {
    return (
        <ul aria-label={label} className="divide-y divide-border rounded-lg border border-border">
            {children}
        </ul>
    );
}

/** One run: its outcome, why it fired and when, and what it did folded under. */
export function RunRow({
    outcome,
    cause,
    at,
    atTitle,
    expanded,
    onToggle,
    children
}: {
    outcome: RuleOutcome;
    cause: ReactNode;
    /** When it started, as the caller reads a time. */
    at: ReactNode;
    atTitle?: string;
    expanded: boolean;
    onToggle: () => void;
    children?: ReactNode;
}) {
    return (
        <li className="flex flex-col">
            <button
                type="button"
                aria-expanded={expanded}
                onClick={onToggle}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left"
            >
                <OutcomeBadge outcome={outcome} />
                <span className="min-w-0 flex-1 truncate text-sm" title={typeof cause === "string" ? cause : undefined}>
                    {cause}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-foreground-subtle" title={atTitle}>
                    {at}
                </span>
                <ChevronDown
                    className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform",
                        expanded && "rotate-180"
                    )}
                />
            </button>
            {expanded && (
                <div className="flex flex-col gap-2 border-t border-border bg-surface px-3 py-2">
                    {children}
                </div>
            )}
        </li>
    );
}
