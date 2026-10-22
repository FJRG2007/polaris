"use client";

/**
 * Search over every docs page and heading, from an index built with the site.
 * Ctrl+K or / focuses it; Enter opens the first result.
 */

import { useEffect, useMemo, useRef, useState } from "react";

export interface SearchRecord {
    readonly title: string;
    readonly section: string;
    readonly href: string;
    readonly text: string;
}

export function DocsSearch({
    records,
    label,
    empty
}: {
    records: readonly SearchRecord[];
    label: string;
    empty: string;
}) {
    const [query, setQuery] = useState("");
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const typing = event.target instanceof HTMLElement && /INPUT|TEXTAREA/.test(event.target.tagName);
            if ((event.key === "k" && (event.ctrlKey || event.metaKey)) || (event.key === "/" && !typing)) {
                event.preventDefault();
                input.current?.focus();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
    const results = useMemo(() => {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        if (!words.length) return [];
        return records
            .filter((record) => {
                const hay = `${record.title} ${record.section} ${record.text}`.toLowerCase();
                return words.every((word) => hay.includes(word));
            })
            .slice(0, 12);
    }, [query, records]);
    return (
        <div className="relative">
            <input
                ref={input}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter" && results[0]) window.location.href = results[0].href;
                    if (event.key === "Escape") setQuery("");
                }}
                placeholder={label}
                aria-label={label}
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
            />
            {query.trim() ? (
                <ul className="absolute inset-x-0 top-10 z-20 max-h-80 overflow-y-auto rounded-md border border-border bg-card p-1 shadow-lg">
                    {results.length ? (
                        results.map((record) => (
                            <li key={record.href}>
                                <a
                                    href={record.href}
                                    className="flex min-w-0 flex-col rounded px-2 py-1.5 hover:bg-muted"
                                >
                                    <span className="truncate text-sm" title={record.title}>{record.title}</span>
                                    <span className="truncate text-xs text-muted-foreground">
                                        {record.section}
                                    </span>
                                </a>
                            </li>
                        ))
                    ) : (
                        <li className="px-2 py-1.5 text-sm text-muted-foreground">{empty}</li>
                    )}
                </ul>
            ) : null}
        </div>
    );
}
