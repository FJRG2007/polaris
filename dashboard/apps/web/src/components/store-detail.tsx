"use client";

/**
 * The pieces of a store item's own page, shared by the Marketplace's apps, the
 * Polaris apps screen and the device plugins: the way back to the list, the
 * header (mark, name, who made it, what it is), a titled section, the
 * Information list, and What's new one version at a time. The page decides
 * what goes in each; the shape is the same everywhere, so an app and a plugin
 * read as the same kind of thing.
 */

import Link from "next/link";
import { Badge, cn } from "@polaris/ui";
import { ArrowLeft } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

export function DetailBack({ href, children }: { href: string; children: ReactNode }) {
    return (
        <Link
            data-swipe-back
            href={href}
            className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm"
        >
            <ArrowLeft className="size-4" />
            {children}
        </Link>
    );
}

/** The item's mark, name and byline, with what follows them (a summary, a badge, a status). */
export function DetailHeader({
    mark,
    name,
    byline,
    children
}: {
    mark: ReactNode;
    name: string;
    byline: ReactNode;
    children?: ReactNode;
}) {
    return (
        <header className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start">
            {mark}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <h1 className="break-words text-2xl font-semibold">{name}</h1>
                <p className="text-muted-foreground break-words text-sm">{byline}</p>
                {children}
            </div>
        </header>
    );
}

/** One titled part of the page. `id` lets a menu or a search result open it. */
export function DetailSection({
    title,
    id,
    children
}: {
    title: ReactNode;
    id?: string;
    children: ReactNode;
}) {
    const heading = useId();
    return (
        <section
            id={id}
            aria-labelledby={heading}
            className="flex min-w-0 scroll-mt-4 flex-col gap-2"
        >
            <h2 id={heading} className="text-sm font-medium">
                {title}
            </h2>
            {children}
        </section>
    );
}

/** The Information list: label and value side by side, stacked on a phone. */
export function DetailFacts({ children }: { children: ReactNode }) {
    return (
        <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
            {children}
        </dl>
    );
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{children}</dd>
        </>
    );
}

/** One version's notes; `version` null for notes that name none. */
export interface DetailRelease {
    readonly version: string | null;
    readonly notes: string;
}

/** Versions shown before "Show all". */
export const RELEASES_SHOWN = 3;

/**
 * What's new, one version per entry, newest first: the latest few open, the
 * rest behind "Show all", the way a store's version history reads. `current`
 * marks the version this computer runs, `newer` the one an update brings.
 */
export function DetailReleases({
    releases,
    current = null,
    words
}: {
    releases: readonly DetailRelease[];
    current?: string | null;
    words: {
        readonly version: (version: string) => string;
        readonly earlier: string;
        readonly current: string;
        readonly showAll: (count: number) => string;
        readonly showLess: string;
    };
}) {
    const [all, setAll] = useState(false);
    const list = useId();
    const shown = all ? releases : releases.slice(0, RELEASES_SHOWN);
    return (
        <div className="flex min-w-0 flex-col gap-3">
            <ol id={list} className="flex min-w-0 flex-col gap-3">
                {shown.map((release, index) => (
                    <li key={release.version ?? `earlier-${index}`} className="flex min-w-0 flex-col gap-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <h3 className="text-sm font-medium">
                                {release.version ? words.version(release.version) : words.earlier}
                            </h3>
                            {release.version && release.version === current ? (
                                <Badge>{words.current}</Badge>
                            ) : null}
                        </div>
                        <p className="text-muted-foreground whitespace-pre-line break-words text-sm">
                            {release.notes}
                        </p>
                    </li>
                ))}
            </ol>
            {releases.length > RELEASES_SHOWN ? (
                <button
                    type="button"
                    aria-expanded={all}
                    aria-controls={list}
                    onClick={() => setAll((value) => !value)}
                    className={cn(
                        "text-muted-foreground hover:text-foreground w-fit text-sm hover:underline",
                        "rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    )}
                >
                    {all ? words.showLess : words.showAll(releases.length)}
                </button>
            ) : null}
        </div>
    );
}
