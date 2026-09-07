"use client";

/**
 * The search box above the list, and the filters behind it.
 *
 * One feature written twice over: the box and the panel are the same search read
 * in two directions. Typing `from:ana has:attachment` fills the panel in; filling
 * the panel in writes that line into the box. Nothing is held anywhere else, so a
 * search stays a page somebody can go back to, bookmark, or open in a second tab
 * beside the first - which a form's own state would not be.
 *
 * It searches what Polaris holds - the window it keeps of each folder - and says
 * so when it comes back with nothing, rather than implying the message does not
 * exist. It very often does and is simply older than the window.
 *
 * Typing is debounced, because every keystroke is a database query and a router
 * navigation. Pressing the panel's own button is not: somebody who has filled in
 * four fields and pressed Search has finished.
 */

import * as core from "@polaris/core";
import { Button, Checkbox, Input, cn } from "@polaris/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** How long typing settles before the address changes. Long enough that a
 *  sentence is one navigation, short enough that it feels immediate. */
const SETTLE_MS = 300;

export function MailSearch() {
    const router = useRouter();
    const pathname = usePathname();
    const search = useSearchParams();
    const applied = search.get("q") ?? "";
    const [typed, setTyped] = useState(applied);
    const [filtersOpen, setFiltersOpen] = useState(false);

    // The address changed under the box: a back button, or another screen
    // linking here with a query already on it.
    useEffect(() => {
        setTyped(applied);
    }, [applied]);

    const apply = useCallback(
        (value: string) => {
            const next = new URLSearchParams(search.toString());
            if (value.trim()) next.set("q", value.trim());
            else next.delete("q");
            // A new search starts at the top: the cursor belongs to the previous
            // one and would skip the first page of this one.
            next.delete("before");
            next.delete("open");
            const query = next.toString();
            router.replace(query ? `${pathname}?${query}` : pathname);
        },
        [pathname, router, search]
    );

    useEffect(() => {
        if (typed === applied) return;
        const timer = setTimeout(() => apply(typed), SETTLE_MS);
        return () => clearTimeout(timer);
    }, [typed, applied, apply]);

    return (
        <div className="relative">
            <div className="relative">
                <Search
                    className="pointer-events-none absolute left-2 top-1/2 size-3.5 shrink-0 -translate-y-1/2 text-foreground-subtle"
                    aria-hidden
                />
                <Input
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") apply(typed);
                        if (event.key === "Escape") setFiltersOpen(false);
                    }}
                    placeholder="Search mail"
                    aria-label="Search mail"
                    className="h-8 pl-7 pr-14 text-[13px]"
                />
                <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center">
                    {typed ? (
                        <button
                            type="button"
                            aria-label="Clear the search"
                            title="Clear the search"
                            className="p-1 text-foreground-subtle hover:text-foreground"
                            onClick={() => {
                                setTyped("");
                                apply("");
                            }}
                        >
                            <X className="size-3.5 shrink-0" aria-hidden />
                        </button>
                    ) : null}
                    <button
                        type="button"
                        aria-label="Search options"
                        title="Search options"
                        aria-expanded={filtersOpen}
                        className={cn(
                            "p-1 text-foreground-subtle hover:text-foreground",
                            filtersOpen && "text-foreground"
                        )}
                        onClick={() => setFiltersOpen((held) => !held)}
                    >
                        <SlidersHorizontal className="size-3.5 shrink-0" aria-hidden />
                    </button>
                </div>
            </div>

            {filtersOpen ? (
                <SearchFilters
                    from={typed}
                    onClose={() => setFiltersOpen(false)}
                    onSearch={(value) => {
                        setTyped(value);
                        apply(value);
                        setFiltersOpen(false);
                    }}
                />
            ) : null}
        </div>
    );
}

/**
 * The panel.
 *
 * Every field writes into one `terms` object and the object is written back out
 * as the line that goes in the box, so there is no second source of truth to
 * disagree with the box - which is the failure every advanced-search panel has:
 * you type in the box, open the panel, and the panel has forgotten.
 */
function SearchFilters({
    from,
    onSearch,
    onClose
}: {
    from: string;
    onSearch: (value: string) => void;
    onClose: () => void;
}) {
    const [terms, setTerms] = useState<core.MailSearchTerms>(() => core.parseMailSearch(from));
    const panel = useRef<HTMLDivElement | null>(null);

    // Clicking anywhere else closes it, which is what a panel hanging under a
    // box has to do or it sits over the list somebody is trying to read.
    useEffect(() => {
        function onDown(event: MouseEvent): void {
            if (!panel.current || panel.current.contains(event.target as Node)) return;
            // The button that opened it toggles on its own click; closing here
            // as well would reopen it.
            if ((event.target as HTMLElement).closest('[aria-label="Search options"]')) return;
            onClose();
        }
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
    }, [onClose]);

    const set = (change: Partial<core.MailSearchTerms>) => setTerms((held) => ({ ...held, ...change }));
    /** A field that holds a list, edited as the one value people actually type
     *  into it. Two `from:` in one search is possible and rare; the box is where
     *  somebody writes that. */
    const one = (values: readonly string[]): string => values[0] ?? "";
    const asList = (value: string): string[] => (value.trim() ? [value.trim()] : []);

    return (
        <div
            ref={panel}
            className="absolute left-0 right-0 top-full z-30 mt-1 rounded-md border border-border bg-surface p-3 shadow-lg"
        >
            <div className="grid grid-cols-2 gap-2">
                <Field label="From" value={one(terms.from)} onChange={(value) => set({ from: asList(value) })} />
                <Field label="To" value={one(terms.to)} onChange={(value) => set({ to: asList(value) })} />
                <Field label="Cc" value={one(terms.cc)} onChange={(value) => set({ cc: asList(value) })} />
                <Field
                    label="Subject"
                    value={one(terms.subject)}
                    onChange={(value) => set({ subject: asList(value) })}
                />
                <Field
                    label="Has the words"
                    value={terms.text}
                    onChange={(value) => set({ text: value })}
                />
                <Field
                    label="Does not have"
                    value={one(terms.without)}
                    onChange={(value) => set({ without: asList(value) })}
                />
                <Field
                    label="This exact wording"
                    value={one(terms.phrases)}
                    onChange={(value) => set({ phrases: asList(value) })}
                />
                <div className="grid grid-cols-2 gap-2">
                    <Field
                        label="After"
                        type="date"
                        value={terms.after}
                        onChange={(value) => set({ after: value })}
                    />
                    <Field
                        label="Before"
                        type="date"
                        value={terms.before}
                        onChange={(value) => set({ before: value })}
                    />
                </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <Tick
                    label="Has an attachment"
                    checked={terms.hasAttachment}
                    onChange={(next) => set({ hasAttachment: next })}
                />
                <Tick label="Has a link" checked={terms.hasLink} onChange={(next) => set({ hasLink: next })} />
                <Tick
                    label="Unread"
                    checked={terms.unread === true}
                    onChange={(next) => set({ unread: next ? true : null })}
                />
                <Tick
                    label="Starred"
                    checked={terms.starred === true}
                    onChange={(next) => set({ starred: next ? true : null })}
                />
            </div>

            <div className="mt-3 flex items-center justify-between gap-2">
                <button
                    type="button"
                    className="text-[12px] text-muted-foreground underline hover:text-foreground"
                    onClick={() => setTerms(core.EMPTY_SEARCH)}
                >
                    Clear everything
                </button>
                <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button size="sm" onClick={() => onSearch(core.formatMailSearch(terms))}>
                        Search
                    </Button>
                </div>
            </div>

            <p className="mt-2 text-[12px] text-foreground-subtle">
                Anything here can be typed into the box instead: <code>from:ana</code>,{" "}
                <code>has:attachment</code>, <code>after:2026-01-01</code>, <code>&quot;exact words&quot;</code>,{" "}
                <code>-excluded</code>.
            </p>
        </div>
    );
}

function Field({
    label,
    value,
    type,
    onChange
}: {
    label: string;
    value: string;
    type?: string;
    onChange: (value: string) => void;
}) {
    return (
        <label className="block">
            <span className="mb-1 block text-[12px] text-muted-foreground">{label}</span>
            <Input
                type={type}
                value={value}
                className="h-8 text-[13px]"
                onChange={(event) => onChange(event.target.value)}
            />
        </label>
    );
}

function Tick({
    label,
    checked,
    onChange
}: {
    label: string;
    checked: boolean;
    onChange: (next: boolean) => void;
}) {
    return (
        <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Checkbox checked={checked} onChange={(event) => onChange(event.target.checked)} />
            {label}
        </label>
    );
}
