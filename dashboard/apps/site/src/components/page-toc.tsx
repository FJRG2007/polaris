"use client";

/**
 * "On this page" beside a guide or an API call, with the section being read
 * marked as the page scrolls: the last heading that has passed under the
 * header is the current one.
 */

import { useEffect, useState } from "react";

export interface TocItem {
    readonly id: string;
    readonly text: string;
}

/** How far below the top of the window a heading counts as reached: the sticky header and a little air. */
const READ_LINE = 96;

export function PageToc({ label, items }: { label: string; items: readonly TocItem[] }) {
    const [current, setCurrent] = useState<string | null>(items[0]?.id ?? null);

    useEffect(() => {
        const headings = items
            .map((item) => document.getElementById(item.id))
            .filter((node): node is HTMLElement => node !== null);
        if (!headings.length) return;
        let frame = 0;
        const update = () => {
            frame = 0;
            let reached = headings[0]!.id;
            for (const heading of headings)
                if (heading.getBoundingClientRect().top <= READ_LINE) reached = heading.id;
            // At the very bottom the last section is the one being read, however short it is.
            if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2)
                reached = headings[headings.length - 1]!.id;
            setCurrent(reached);
        };
        const onScroll = () => {
            if (!frame) frame = window.requestAnimationFrame(update);
        };
        update();
        window.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", onScroll);
        return () => {
            window.removeEventListener("scroll", onScroll);
            window.removeEventListener("resize", onScroll);
            if (frame) window.cancelAnimationFrame(frame);
        };
    }, [items]);

    return (
        <nav
            aria-label={label}
            className="hidden shrink-0 flex-col gap-1 text-sm xl:sticky xl:top-20 xl:flex xl:max-h-[calc(100vh-6rem)] xl:w-48 xl:self-start xl:overflow-y-auto"
        >
            <p className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                {label}
            </p>
            {items.map((item) => (
                <a
                    key={item.id}
                    href={`#${item.id}`}
                    aria-current={item.id === current ? "location" : undefined}
                    className="truncate border-l-2 border-transparent pl-2 text-muted-foreground hover:text-foreground aria-[current=location]:border-primary aria-[current=location]:text-foreground"
                    title={item.text}
                >
                    {item.text}
                </a>
            ))}
        </nav>
    );
}

/** The same list folded under its label, for screens too narrow for the column beside the page. */
export function PageTocFolded({ label, items }: { label: string; items: readonly TocItem[] }) {
    return (
        <details className="rounded-md border border-border text-sm xl:hidden">
            <summary className="cursor-pointer select-none px-3 py-2">{label}</summary>
            <ul className="flex flex-col gap-1 border-t border-border p-3">
                {items.map((item) => (
                    <li key={item.id} className="min-w-0">
                        <a
                            href={`#${item.id}`}
                            className="block truncate text-muted-foreground hover:text-foreground"
                            title={item.text}
                        >
                            {item.text}
                        </a>
                    </li>
                ))}
            </ul>
        </details>
    );
}
