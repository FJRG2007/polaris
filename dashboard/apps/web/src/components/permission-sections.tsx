"use client";

/**
 * A long permission list folded by area, with a search over all of it.
 *
 * Every area is a section whose header says what is in it (the caller's
 * `summary` - "3 of 7", "2 overridden") and opens it; the ones the caller marks
 * with `startOpen` are open on arrival, the rest folded, so a list of fifty
 * shows the handful somebody came to see. What the reader opens or folds is
 * kept per `storageKey` in this browser, a convenience only: a private window
 * starts from the defaults again.
 *
 * The search matches an entry's name or its key, accents and case aside, or an
 * area's name. While it has text, every area with a match is open and the rest
 * are hidden; a search with no match says so. Pure display: the caller draws
 * the entries (`renderItems`) and holds whatever they change.
 */

import { Button, Input, cn } from "@polaris/ui";
import { ChevronRight, Search } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import {
    filterSections,
    openSections,
    parseChosen,
    type Section,
    type SectionItem
} from "@/lib/permission-sections";

const STORAGE_PREFIX = "polaris.permissionSections.";

export function PermissionSections<T extends SectionItem>({
    sections,
    renderItems,
    summary,
    startOpen,
    lead,
    trail,
    keep,
    toolbar,
    storageKey
}: {
    sections: readonly Section<T>[];
    /** The entries of one open section, already narrowed by the search. */
    renderItems: (section: Section<T>) => ReactNode;
    /** What the header says about the whole area, search aside. */
    summary: (section: Section<T>) => ReactNode;
    startOpen: (section: Section<T>) => boolean;
    /** Drawn before the header's toggle - a box that acts on the visible entries. */
    lead?: (section: Section<T>) => ReactNode;
    /** Drawn after the header's toggle - an action on the area. */
    trail?: (section: Section<T>) => ReactNode;
    /** A filter on top of the search, such as "only overridden". */
    keep?: (item: T) => boolean;
    /** Beside the search: the caller's own filters. */
    toolbar?: ReactNode;
    /** Where the reader's open and folded areas are remembered; none without. */
    storageKey?: string;
}) {
    const tc = useTranslations("common");
    const baseId = useId();
    const [query, setQuery] = useState("");
    const [chosen, setChosen] = useState<Record<string, boolean>>({});

    // Read after mounting rather than in the initial state, so the server's
    // markup and the first client render agree.
    useEffect(() => {
        if (!storageKey) return;
        try {
            setChosen(parseChosen(localStorage.getItem(STORAGE_PREFIX + storageKey)));
        } catch {
            // Storage blocked: the defaults stand.
        }
    }, [storageKey]);

    function remember(next: Record<string, boolean>) {
        setChosen(next);
        if (!storageKey) return;
        try {
            localStorage.setItem(STORAGE_PREFIX + storageKey, JSON.stringify(next));
        } catch {
            // Storage blocked or full: the choice lasts for this visit only.
        }
    }

    const searching = query.trim() !== "";
    const visible = useMemo(() => filterSections(sections, query, keep), [sections, query, keep]);
    const whole = useMemo(() => new Map(sections.map((section) => [section.id, section])), [sections]);
    const open = useMemo(
        () =>
            openSections(
                sections.map((section) => section.id),
                chosen,
                (id) => startOpen(whole.get(id)!)
            ),
        [sections, chosen, startOpen, whole]
    );
    const allOpen = visible.every((section) => open.has(section.id));

    function setAll(next: boolean) {
        const all = { ...chosen };
        for (const section of visible) all[section.id] = next;
        remember(all);
    }

    return (
        <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative min-w-0 flex-1">
                    <Search
                        aria-hidden
                        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                        type="search"
                        className="pl-9"
                        placeholder={tc("permissionSections.search")}
                        aria-label={tc("permissionSections.search")}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {toolbar}
                    {searching || visible.length === 0 ? null : (
                        <Button size="sm" variant="ghost" onClick={() => setAll(!allOpen)}>
                            {allOpen
                                ? tc("permissionSections.collapseAll")
                                : tc("permissionSections.expandAll")}
                        </Button>
                    )}
                </div>
            </div>

            {visible.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                    {searching
                        ? tc("permissionSections.noMatch", { query: query.trim() })
                        : tc("permissionSections.empty")}
                </p>
            ) : (
                <div className="flex min-w-0 flex-col rounded-md border border-border">
                    {visible.map((section) => {
                        const full = whole.get(section.id) ?? section;
                        const expanded = searching || open.has(section.id);
                        const panelId = `${baseId}-${section.id}`;
                        return (
                            <section
                                key={section.id}
                                className="min-w-0 border-b border-border last:border-b-0"
                            >
                                <div className="flex min-w-0 items-center gap-2 px-3 py-2">
                                    {lead?.(section)}
                                    <button
                                        type="button"
                                        aria-expanded={expanded}
                                        aria-controls={expanded ? panelId : undefined}
                                        disabled={searching}
                                        onClick={() =>
                                            remember({ ...chosen, [section.id]: !expanded })
                                        }
                                        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                                    >
                                        <span
                                            className="min-w-0 flex-1 truncate font-medium"
                                            title={section.label}
                                        >
                                            {section.label}
                                        </span>
                                        <span className="shrink-0">{summary(full)}</span>
                                        <ChevronRight
                                            aria-hidden
                                            className={cn(
                                                "size-4 shrink-0 text-muted-foreground transition-transform duration-fast",
                                                expanded && "rotate-90"
                                            )}
                                        />
                                    </button>
                                    {trail?.(full)}
                                </div>
                                {expanded ? (
                                    <div id={panelId} className="min-w-0 px-3 pb-3">
                                        {renderItems(section)}
                                    </div>
                                ) : null}
                            </section>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
