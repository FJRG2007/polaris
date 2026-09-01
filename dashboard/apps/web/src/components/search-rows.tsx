"use client";

/**
 * The four things the search panel can list, and how each is drawn.
 *
 * They are deliberately not one row with four variations. A page and a task are
 * not the same kind of answer: a page is a place that was always going to be
 * there, a task is a record that existed when the query ran and carries its own
 * handle and state. Somebody scanning the list should be able to tell which half
 * of the panel they are looking at without reading it, which is why the ones
 * that came from the database wear a face - a status colour, an avatar, a
 * reference - and the ones that came from the app registry wear an icon.
 */

import { Badge, cn } from "@polaris/ui";
import { Avatar } from "@/components/avatar";
import type { LucideIcon } from "lucide-react";
import type { RecentSearch } from "@polaris/core";
import { Clock, CornerDownLeft, X } from "lucide-react";
import type { CommandEntry } from "@/lib/search/entries";
import type { SearchHit } from "@/lib/search/lookup-service";
import type { SearchScopeDefinition } from "@/lib/search/scopes";

/** What every row is given, whatever it draws inside. */
export interface RowProps {
    /** Pointed at by the field's `aria-activedescendant` when this row is the
     *  one the arrow keys are on. */
    id: string;
    selected: boolean;
    onSelect: () => void;
    onHover: () => void;
}

/** Shared shell: the same height, padding and highlight for every kind of row. */
function Row({
    id,
    selected,
    onSelect,
    onHover,
    children,
    label
}: RowProps & { children: React.ReactNode; label: string }) {
    return (
        <div
            id={id}
            role="option"
            aria-selected={selected}
            aria-label={label}
            data-active={selected}
            onMouseMove={onHover}
            onClick={onSelect}
            className={cn(
                "flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-left transition-colors",
                selected ? "bg-muted" : "hover:bg-muted/60"
            )}
        >
            {children}
        </div>
    );
}

/** A destination the app registry already knew about. */
export function EntryRow({ entry, ...row }: RowProps & { entry: CommandEntry }) {
    const Icon: LucideIcon = entry.icon;
    return (
        <Row {...row} label={entry.label}>
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm" title={entry.label}>{entry.label}</span>
                {entry.context ? (
                    <span className="block truncate text-xs text-muted-foreground" title={entry.context}>{entry.context}</span>
                ) : null}
            </span>
        </Row>
    );
}

/** A command, offered while its word is being typed. */
export function CommandRow({ scope, ...row }: RowProps & { scope: SearchScopeDefinition }) {
    const Icon = scope.icon;
    return (
        <Row {...row} label={`Search ${scope.label}`}>
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm" title={scope.placeholder}>{scope.placeholder}</span>
            </span>
            <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[0.625rem] leading-none text-muted-foreground">
                {scope.sigil ?? `/${scope.keywords[0]}`}
            </kbd>
        </Row>
    );
}

/**
 * A record that was looked up when the query ran.
 *
 * The badge, the status dot and the avatar are the whole point: these rows are
 * live data with a state of their own, not entries in a list of screens.
 */
export function HitRow({ hit, ...row }: RowProps & { hit: SearchHit }) {
    return (
        <Row {...row} label={hit.label}>
            {hit.scope === "users" ? (
                <Avatar person={{ id: hit.id, name: hit.label, image: hit.image ?? null }} size={22} />
            ) : hit.status ? (
                <span
                    aria-hidden="true"
                    title={hit.status.name}
                    className="size-2.5 shrink-0 rounded-full ring-2 ring-background"
                    style={{ backgroundColor: hit.status.color }}
                />
            ) : (
                <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-muted-foreground/40" />
            )}
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                    {hit.reference ? (
                        <Badge className="shrink-0 font-mono text-[0.625rem]">
                            {hit.reference}
                        </Badge>
                    ) : null}
                    <span className="min-w-0 truncate text-sm" title={hit.label}>{hit.label}</span>
                </span>
                {hit.detail ? (
                    <span className="block truncate text-xs text-muted-foreground" title={hit.detail}>{hit.detail}</span>
                ) : null}
            </span>
            {hit.status ? (
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">{hit.status.name}</span>
            ) : null}
        </Row>
    );
}

/** Something searched before: a result to reopen, or words to run again. */
export function RecentRow({
    entry,
    scopeLabel,
    onForget,
    ...row
}: RowProps & {
    entry: RecentSearch;
    /** The command it was made under, already resolved to its name. */
    scopeLabel: string | null;
    onForget: () => void;
}) {
    return (
        <Row {...row} label={entry.label}>
            {entry.kind === "result" ? (
                <CornerDownLeft className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : (
                <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1 truncate text-sm" title={entry.label}>{entry.label}</span>
            {scopeLabel ? (
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">{scopeLabel}</span>
            ) : null}
            <button
                type="button"
                title="Remove from recent searches"
                aria-label={`Remove ${entry.label} from recent searches`}
                onClick={(event) => {
                    // The row underneath opens what it names; this only forgets it.
                    event.stopPropagation();
                    onForget();
                }}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
            >
                <X className="size-3.5" aria-hidden="true" />
            </button>
        </Row>
    );
}

/** Placeholder rows while a scoped search is in flight. */
export function HitSkeleton() {
    return (
        <div aria-hidden="true" className="space-y-1 p-1">
            {[0, 1, 2].map((row) => (
                <div key={row} className="flex items-center gap-3 rounded-md px-2 py-2">
                    <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-muted" />
                    <span className="h-3 flex-1 animate-pulse rounded bg-muted" style={{ maxWidth: `${70 - row * 12}%` }} />
                </div>
            ))}
        </div>
    );
}
