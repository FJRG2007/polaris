"use client";

/**
 * Choosing what to pin to the Overview.
 *
 * The same two halves the command palette searches, for the same reason: every
 * fixed screen is known from the navigation registries and matched here, and the
 * named things somebody owns - projects, services, servers, installed apps -
 * come from /api/search already scoped to what they may open. Pinning cannot
 * therefore be used to reach anything that clicking it would refuse.
 *
 * Deliberately the same index rather than a second one: a page that can be found
 * can be pinned, and there is no list to keep in step.
 */

import Fuse from "fuse.js";
import { Check, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { OverviewShortcut } from "@polaris/core";
import { Dialog, DialogContent, DialogTitle, Input, cn } from "@polaris/ui";
import { navigationEntries, resourceEntries, type CommandEntry, type SearchResource } from "@/lib/search/entries";

/** Matches shown at once. Past this, narrowing the query is the way to find it. */
const MAX_RESULTS = 30;

export function ShortcutPicker({
    open,
    onOpenChange,
    isAdmin,
    appIds,
    pinned,
    onPick
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    isAdmin: boolean;
    appIds: readonly string[];
    pinned: readonly OverviewShortcut[];
    onPick: (shortcut: OverviewShortcut) => void;
}) {
    const [query, setQuery] = useState("");
    const [resources, setResources] = useState<SearchResource[]>([]);

    useEffect(() => {
        if (!open) return;
        setQuery("");
        const controller = new AbortController();
        void fetch("/api/search", { cache: "no-store", signal: controller.signal })
            .then((response) => (response.ok ? response.json() : { resources: [] }))
            .then((body: { resources?: SearchResource[] }) => setResources(body.resources ?? []))
            .catch(() => undefined);
        return () => controller.abort();
    }, [open]);

    const appKey = appIds.join(",");
    const pool = useMemo(
        () => [...navigationEntries(isAdmin, appKey ? appKey.split(",") : []), ...resourceEntries(resources)],
        [isAdmin, appKey, resources]
    );

    const fuse = useMemo(
        () =>
            new Fuse(pool, {
                threshold: 0.4,
                ignoreLocation: true,
                keys: [
                    { name: "label", weight: 3 },
                    { name: "keywords", weight: 2 },
                    { name: "context", weight: 1 },
                    { name: "group", weight: 1 }
                ]
            }),
        [pool]
    );

    const trimmed = query.trim();
    const results = useMemo(() => {
        const matches = trimmed ? fuse.search(trimmed, { limit: MAX_RESULTS }).map((match) => match.item) : pool;
        return matches.slice(0, MAX_RESULTS);
    }, [trimmed, fuse, pool]);

    const alreadyPinned = new Set(pinned.map((shortcut) => shortcut.href));

    function pick(entry: CommandEntry): void {
        if (alreadyPinned.has(entry.href)) return;
        onPick({ label: entry.label, href: entry.href, context: entry.context ?? entry.group });
        onOpenChange(false);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent showClose={false} className="max-w-lg overflow-hidden p-0">
                <DialogTitle className="sr-only">Pin a page to your Overview</DialogTitle>
                <div className="flex items-center gap-2 border-b border-border px-3">
                    <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <Input
                        autoFocus
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Find a page or service to pin"
                        aria-label="Find a page or service to pin"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        bare
                            className="h-12"
                    />
                </div>
                <div className="max-h-[min(60vh,24rem)] overflow-y-auto overscroll-contain p-2">
                    {results.length === 0 ? (
                        <p className="px-2 py-10 text-center text-sm text-muted-foreground">
                            {trimmed ? `Nothing matches "${trimmed}".` : "Nothing to pin yet."}
                        </p>
                    ) : (
                        results.map((entry) => {
                            const Icon = entry.icon;
                            const held = alreadyPinned.has(entry.href);
                            return (
                                <button
                                    key={entry.id}
                                    type="button"
                                    disabled={held}
                                    onClick={() => pick(entry)}
                                    className={cn(
                                        "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
                                        held ? "cursor-default opacity-60" : "hover:bg-muted"
                                    )}
                                >
                                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                    <span className="flex min-w-0 flex-1 flex-col">
                                        <span className="truncate text-sm" title={entry.label}>{entry.label}</span>
                                        <span className="truncate text-xs text-muted-foreground">
                                            {entry.context ?? entry.group}
                                        </span>
                                    </span>
                                    {held ? (
                                        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                                            <Check className="size-3.5" aria-hidden="true" />
                                            Pinned
                                        </span>
                                    ) : null}
                                </button>
                            );
                        })
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
