"use client";

/**
 * A first-match-wins rule set, as a list you can read in one pass - shared by the
 * firewall's custom rules and an account's own access rules.
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
 *
 * What differs between the screens - the words around the list, how a rule is
 * described, how its action reads, and whether a column of recent matches exists -
 * is passed in; the table, the drag and the row menu are the same everywhere.
 */

import { useState, type ReactNode } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
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
    Switch,
    type BadgeProps
} from "@polaris/ui";

/** What the list needs to know about a rule. */
export interface ListedRule {
    name: string;
    enabled: boolean;
}

/** The list with one entry moved, or unchanged when the target is off the ends. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
    if (to < 0 || to >= list.length || from === to) return [...list];
    const next = [...list];
    const [entry] = next.splice(from, 1);
    if (entry !== undefined) next.splice(to, 0, entry);
    return next;
}

/** The screen's own words around the list. */
export interface RuleListWords {
    title: string;
    /** Shown in place of the table when there are no rules. */
    empty: ReactNode;
    orderHint: string;
    deleteBody: string;
}

export function SharedRuleList<R extends ListedRule>({
    rules,
    max,
    canEdit,
    hidden,
    words,
    describe,
    actionBadge,
    matchesColumn,
    onEdit,
    onCreate,
    onChange
}: {
    rules: readonly R[];
    max: number;
    canEdit: boolean;
    /** Indices the current search filters out. The list is never actually filtered -
     *  every operation here is by index, and renumbering under a search is how a drag
     *  ends up moving the wrong rule. */
    hidden?: ReadonlySet<number>;
    words: RuleListWords;
    describe: (rule: R) => string;
    actionBadge: (rule: R) => { variant: BadgeProps["variant"]; label: string };
    /** A column of recent matches, for a rule set that can count them. */
    matchesColumn?: (rule: R, index: number) => ReactNode;
    onEdit: (index: number) => void;
    onCreate: () => void;
    /** The whole list, already reordered/toggled/removed. The caller persists it. */
    onChange: (next: R[]) => void;
}) {
    const t = useTranslations("firewall");
    // Where the drag started, and which row it is currently over. Held here rather
    // than per row so the drop target can draw the insertion line without every row
    // knowing about every other one.
    const [dragging, setDragging] = useState<number | null>(null);
    const [over, setOver] = useState<number | null>(null);
    // The rule the reader has asked to delete, held until they confirm. By index,
    // like every other operation here - two rules are allowed to share a name.
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
                    <h2 className="min-w-0 truncate text-sm font-semibold" title={words.title}>{words.title}</h2>
                    <span className="shrink-0 text-xs text-muted-foreground">
                        {t("list.count", { count: rules.length, max })}
                    </span>
                </div>
                <Button
                    type="button"
                    size="sm"
                    disabled={!canEdit || rules.length >= max}
                    title={rules.length >= max ? t("list.atMost", { max }) : undefined}
                    onClick={onCreate}
                >
                    <Plus className="size-4 shrink-0" aria-hidden="true" />
                    {t("list.create")}
                </Button>
            </header>

            {rules.length === 0 ? (
                <div className="border-t border-border px-4 py-8 text-center text-sm text-muted-foreground">
                    {words.empty}
                </div>
            ) : (
                <div className="overflow-x-auto border-t border-border">
                    <table className={`w-full text-sm ${matchesColumn ? "min-w-[48rem]" : "min-w-[40rem]"}`}>
                        <thead>
                            <tr className="text-start text-xs text-muted-foreground">
                                <th className="w-8 px-2 py-2.5" aria-label={t("list.columns.reorder")} />
                                <th className="w-14 px-2 py-2.5 font-medium">{t("list.columns.order")}</th>
                                <th className="px-4 py-2.5 font-medium">{t("list.columns.name")}</th>
                                <th className="px-4 py-2.5 font-medium">{t("list.columns.description")}</th>
                                <th className="w-24 px-3 py-2.5 font-medium">{t("list.columns.action")}</th>
                                {matchesColumn ? (
                                    <th className="w-32 px-3 py-2.5 font-medium">{t("list.columns.matches")}</th>
                                ) : null}
                                <th className="w-24 px-3 py-2.5 font-medium">{t("list.columns.status")}</th>
                                <th className="w-10 px-2 py-2.5" aria-label={t("list.columns.actions")} />
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
                                        description={describe(rule)}
                                        badge={actionBadge(rule)}
                                        matches={matchesColumn ? matchesColumn(rule, index) : undefined}
                                        hasMatches={!!matchesColumn}
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
                                            // A copy is a new rule: whatever identifies the
                                            // original stays with the original.
                                            const { id: _id, ...rest } = rule as R & { id?: unknown };
                                            const copy = {
                                                ...rest,
                                                name: t("list.copyName", { name: rule.name }).slice(0, 80)
                                            } as unknown as R;
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

            <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{words.orderHint}</p>

            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => (open ? undefined : setDeleting(null))}
                kind={t("list.kind")}
                requireTyping={false}
                name={deleting === null ? "" : (rules[deleting]?.name ?? "")}
                description={words.deleteBody}
                onConfirm={() => {
                    if (deleting === null) return;
                    onChange(rules.filter((_, i) => i !== deleting));
                    setDeleting(null);
                }}
            />
        </section>
    );
}

function RuleRow<R extends ListedRule>({
    rule,
    index,
    total,
    canEdit,
    description,
    badge,
    matches,
    hasMatches,
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
    rule: R;
    index: number;
    total: number;
    canEdit: boolean;
    description: string;
    badge: { variant: BadgeProps["variant"]; label: string };
    matches: ReactNode;
    hasMatches: boolean;
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
    const t = useTranslations("firewall");
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
            <td className="min-w-[10rem] px-4 py-3.5 pe-6 align-top">
                <button
                    type="button"
                    onClick={onEdit}
                    className="rounded text-start font-medium underline-offset-2 [overflow-wrap:anywhere] hover:underline "
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
                <Badge variant={badge.variant}>{badge.label}</Badge>
            </td>
            {hasMatches ? <td className="px-3 py-3.5 align-top">{matches}</td> : null}
            <td className="px-3 py-3.5 align-top">
                <div className="flex items-center gap-2">
                    <Switch
                        checked={rule.enabled}
                        disabled={!canEdit}
                        onChange={onToggle}
                        aria-label={rule.enabled ? t("list.disable", { name: rule.name }) : t("list.enable", { name: rule.name })}
                    />
                    <span
                        className="min-w-0 truncate text-xs text-muted-foreground"
                        title={rule.enabled ? t("list.active") : t("list.off")}
                    >
                        {rule.enabled ? t("list.active") : t("list.off")}
                    </span>
                </div>
            </td>
            <td className="px-2 py-3.5 align-top text-end">
                <DropdownMenu>
                    <DropdownMenuTrigger
                        aria-label={t("list.actionsFor", { name: rule.name })}
                        title={t("list.columns.actions")}
                        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground "
                    >
                        <span aria-hidden="true">...</span>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={onEdit}>
                            <Pencil className="size-3.5 shrink-0" aria-hidden="true" />
                            {t("list.edit")}
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={!canEdit || index === 0} onSelect={() => onMove(index - 1)}>
                            <ChevronUp className="size-3.5 shrink-0" aria-hidden="true" />
                            {t("list.moveUp")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            disabled={!canEdit || index === total - 1}
                            onSelect={() => onMove(index + 1)}
                        >
                            <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
                            {t("list.moveDown")}
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={!canEdit} onSelect={onDuplicate}>
                            <Copy className="size-3.5 shrink-0" aria-hidden="true" />
                            {t("list.duplicate")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="danger" disabled={!canEdit} onSelect={onRemove}>
                            <Trash2 className="size-3.5 shrink-0" aria-hidden="true" />
                            {t("list.delete")}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </td>
        </tr>
    );
}
