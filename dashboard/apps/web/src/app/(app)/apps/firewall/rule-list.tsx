"use client";

/**
 * The custom rules, as a list you can read in one pass.
 *
 * This used to be a stack of expanded editors - every rule showing every one of its
 * conditions, so five rules filled the screen and the thing an operator actually came
 * to check, which rule runs before which, was the one thing you had to scroll to work
 * out. A rule set is first-match-wins, so ORDER is the primary fact about it and it
 * gets the first column; everything else about a rule lives behind opening it.
 *
 * Reordering is a drag, because position is a comparison between rows and dragging is
 * how you say "above that one". It is not the only way: a drag is unusable with a
 * keyboard and impossible to announce, so the row menu carries Move up / Move down
 * and they do the same thing.
 */

import { useState } from "react";
import { Sparkline } from "./sparkline";
import { ruleDescription } from "./rule-language";
import type { WafCustomRule } from "@polaris/core";
import { ChevronDown, ChevronUp, Copy, GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import {
    Badge,
    Button,
    ConfirmDeleteDialog,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Skeleton,
    Switch
} from "@polaris/ui";

/** The list with one entry moved, or unchanged when the target is off the ends. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
    if (to < 0 || to >= list.length || from === to) return [...list];
    const next = [...list];
    const [entry] = next.splice(from, 1);
    if (entry !== undefined) next.splice(to, 0, entry);
    return next;
}

export function RuleList({
    rules,
    max,
    canEdit,
    hidden,
    matches,
    onEdit,
    onCreate,
    onChange
}: {
    rules: readonly WafCustomRule[];
    max: number;
    canEdit: boolean;
    /** Indices the current search filters out. The list is never actually filtered -
     *  every operation here is by index, and renumbering under a search is how a drag
     *  ends up moving the wrong rule. */
    hidden?: ReadonlySet<number>;
    /** What each rule matches over recent traffic, by index. Absent until it arrives. */
    matches?: Readonly<Record<string, { total: number; series: number[] }>>;
    onEdit: (index: number) => void;
    onCreate: () => void;
    /** The whole list, already reordered/toggled/removed. The caller persists it. */
    onChange: (next: WafCustomRule[]) => void;
}) {
    // Where the drag started, and which row it is currently over. Held here rather
    // than per row so the drop target can draw the insertion line without every row
    // knowing about every other one.
    const [dragging, setDragging] = useState<number | null>(null);
    const [over, setOver] = useState<number | null>(null);
    // The rule the reader has asked to delete, held until they confirm. By index,
    // like every other operation here - a rule has a name but no identifier, and two
    // rules are allowed to share one.
    const [deleting, setDeleting] = useState<number | null>(null);

    function drop(to: number) {
        setOver(null);
        if (dragging === null) return;
        onChange(moved(rules, dragging, to));
        setDragging(null);
    }

    return (
        <section className="rounded-lg border border-border bg-card">
            <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <div className="flex min-w-0 items-baseline gap-2">
                    <h2 className="text-sm font-semibold">Custom rules</h2>
                    <span className="text-xs text-muted-foreground">
                        {rules.length}/{max} rules
                    </span>
                </div>
                <Button
                    type="button"
                    size="sm"
                    disabled={!canEdit || rules.length >= max}
                    title={rules.length >= max ? `At most ${max} rules` : undefined}
                    onClick={onCreate}
                >
                    <Plus className="size-4 shrink-0" aria-hidden="true" />
                    Create rule
                </Button>
            </header>

            {rules.length === 0 ? (
                <p className="border-t border-border px-4 py-8 text-center text-sm text-muted-foreground">
                    No custom rules. The address lists and managed rules below still apply.
                </p>
            ) : (
                <div className="overflow-x-auto border-t border-border">
                    <table className="w-full min-w-[48rem] text-sm">
                        <thead>
                            <tr className="text-left text-xs text-muted-foreground">
                                <th className="w-8 px-2 py-2.5" aria-label="Reorder" />
                                <th className="w-14 px-2 py-2.5 font-medium">Order</th>
                                <th className="px-4 py-2.5 font-medium">Name</th>
                                <th className="px-4 py-2.5 font-medium">Description</th>
                                <th className="w-24 px-3 py-2.5 font-medium">Action</th>
                                <th className="w-32 px-3 py-2.5 font-medium">Matches</th>
                                <th className="w-24 px-3 py-2.5 font-medium">Status</th>
                                <th className="w-10 px-2 py-2.5" aria-label="Actions" />
                            </tr>
                        </thead>
                        <tbody>
                            {rules.map((rule, index) =>
                                hidden?.has(index) ? null : (
                                <RuleRow
                                    key={index}
                                    rule={rule}
                                    index={index}
                                    total={rules.length}
                                    canEdit={canEdit}
                                    activity={matches?.[`custom:${index}`]}
                                    over={over === index}
                                    onEdit={() => onEdit(index)}
                                    onDragStart={() => setDragging(index)}
                                    onDragEnd={() => {
                                        setDragging(null);
                                        setOver(null);
                                    }}
                                    onDragOver={() => setOver(index)}
                                    onDrop={() => drop(index)}
                                    onMove={(to) => onChange(moved(rules, index, to))}
                                    onToggle={(enabled) =>
                                        onChange(rules.map((entry, i) => (i === index ? { ...entry, enabled } : entry)))
                                    }
                                    onDuplicate={() => {
                                        const copy = { ...rule, name: `${rule.name} (copy)`.slice(0, 80) };
                                        const next = [...rules];
                                        next.splice(index + 1, 0, copy);
                                        onChange(next);
                                    }}
                                    onRemove={() => setDeleting(index)}
                                />
                                )
                            )}
                        </tbody>
                    </table>
                </div>
            )}

            <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
                Rules are evaluated in order and the first one that matches decides. Put an allow above a block to
                carve out an exception.
            </p>

            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => (open ? undefined : setDeleting(null))}
                kind="rule"
                requireTyping={false}
                name={deleting === null ? "" : (rules[deleting]?.name ?? "")}
                description="Traffic it was blocking reaches the service again, unless another rule below it matches."
                onConfirm={() => {
                    if (deleting === null) return;
                    onChange(rules.filter((_, i) => i !== deleting));
                    setDeleting(null);
                }}
            />
        </section>
    );
}

/**
 * What a rule matches over recent traffic, as a line and a count.
 *
 * Shared by the custom rules and the predefined ones, because it says the same thing
 * on both and the caveat has to be identical: this is a replay of the rule over the
 * edge log, so it counts what the rule MATCHES rather than what it caught - which is
 * what makes it worth showing next to a rule that is switched off.
 */
export function MatchesCell({
    name,
    activity
}: {
    name: string;
    activity?: { total: number; series: number[] };
}) {
    if (!activity) return <Skeleton className="h-6 w-24 rounded" />;
    return (
        <div className="flex items-center gap-2">
            <Sparkline
                series={activity.series}
                label={`What ${name} matches over the last day, by hour`}
            />
            <span
                className="tabular-nums text-xs text-muted-foreground"
                title="Requests in the last day this rule matches. Counted by replaying the rule over the edge log, so it is what the rule matches rather than what it caught."
            >
                {activity.total}
            </span>
        </div>
    );
}

/** How each action reads in the Action column. */
const ACTION_BADGE: Record<WafCustomRule["action"], { label: string; variant: "danger" | "success" | "neutral" }> = {
    block: { label: "Block", variant: "danger" },
    allow: { label: "Allow", variant: "success" },
    skip: { label: "Skip", variant: "neutral" }
};

function RuleRow({
    rule,
    index,
    total,
    canEdit,
    activity,
    over,
    onEdit,
    onDragStart,
    onDragEnd,
    onDragOver,
    onDrop,
    onMove,
    onToggle,
    onDuplicate,
    onRemove
}: {
    rule: WafCustomRule;
    index: number;
    total: number;
    canEdit: boolean;
    activity?: { total: number; series: number[] };
    over: boolean;
    onEdit: () => void;
    onDragStart: () => void;
    onDragEnd: () => void;
    onDragOver: () => void;
    onDrop: () => void;
    onMove: (to: number) => void;
    onToggle: (enabled: boolean) => void;
    onDuplicate: () => void;
    onRemove: () => void;
}) {
    const description = ruleDescription(rule);
    return (
        <tr
            draggable={canEdit}
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", String(index));
                onDragStart();
            }}
            onDragEnd={onDragEnd}
            onDragOver={(event) => {
                if (!canEdit) return;
                event.preventDefault();
                onDragOver();
            }}
            onDrop={(event) => {
                if (!canEdit) return;
                event.preventDefault();
                onDrop();
            }}
            className={`border-t border-border transition-colors hover:bg-muted/40 ${
                over ? "border-t-2 border-t-primary" : ""
            } ${rule.enabled ? "" : "opacity-60"}`}
        >
            <td className="px-2 py-3.5 align-top">
                <GripVertical
                    className={`size-4 shrink-0 text-muted-foreground ${canEdit ? "cursor-grab" : "opacity-40"}`}
                    aria-hidden="true"
                />
            </td>
            <td className="px-2 py-3.5 align-top tabular-nums text-muted-foreground">{index + 1}</td>
            <td className="min-w-[10rem] px-4 py-3.5 pr-6 align-top">
                <button
                    type="button"
                    onClick={onEdit}
                    className="rounded text-left font-medium underline-offset-2 hover:underline "
                >
                    {rule.name}
                </button>
            </td>
            <td className="w-full max-w-0 px-4 py-3.5 align-top text-muted-foreground">
                <span className="line-clamp-2 [overflow-wrap:anywhere]" title={description}>
                    {description}
                </span>
            </td>
            <td className="px-3 py-3.5 align-top">
                <Badge variant={ACTION_BADGE[rule.action].variant}>{ACTION_BADGE[rule.action].label}</Badge>
            </td>
            <td className="px-3 py-3.5 align-top">
                <MatchesCell name={rule.name} activity={activity} />
            </td>
            <td className="px-3 py-3.5 align-top">
                <div className="flex items-center gap-2">
                    <Switch
                        checked={rule.enabled}
                        disabled={!canEdit}
                        onChange={onToggle}
                        aria-label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
                    />
                    <span className="text-xs text-muted-foreground">{rule.enabled ? "Active" : "Off"}</span>
                </div>
            </td>
            <td className="px-2 py-3.5 align-top text-right">
                <DropdownMenu>
                    <DropdownMenuTrigger
                        aria-label={`Actions for ${rule.name}`}
                        title="Actions"
                        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground "
                    >
                        <span aria-hidden="true">...</span>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={onEdit}>
                            <Pencil className="size-3.5 shrink-0" aria-hidden="true" />
                            Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={!canEdit || index === 0} onSelect={() => onMove(index - 1)}>
                            <ChevronUp className="size-3.5 shrink-0" aria-hidden="true" />
                            Move up
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            disabled={!canEdit || index === total - 1}
                            onSelect={() => onMove(index + 1)}
                        >
                            <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
                            Move down
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={!canEdit} onSelect={onDuplicate}>
                            <Copy className="size-3.5 shrink-0" aria-hidden="true" />
                            Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="danger" disabled={!canEdit} onSelect={onRemove}>
                            <Trash2 className="size-3.5 shrink-0" aria-hidden="true" />
                            Delete
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </td>
        </tr>
    );
}
