"use client";

/**
 * The apps every Polaris comes with, as the marketplace lists them: one row per
 * app with its logo, its name, the logos of the products it replaces and an
 * Open button.
 *
 * Drawn the same by the dashboard's marketplace and the public site. Where a row
 * leads, the words and the link component come in as props, so this holds the
 * look and nothing else.
 */

import { cn } from "../lib/cn";
import { AppLogo } from "../shell/app-logo";
import { Button } from "../components/button";
import type { ComponentType, ReactNode } from "react";

/** A product an app replaces, with the address its logo is served from. */
export interface ReplacedLogo {
    /** The product as its maker names it; never translated. */
    readonly name: string;
    readonly src: string;
}

export interface BuiltInApp {
    readonly id: string;
    /** The app's name, already in the reader's language. */
    readonly label: string;
    readonly href: string;
    readonly replaces: readonly ReplacedLogo[];
    /** Drawn in the logo's place for an app without one. */
    readonly fallback?: ReactNode;
}

export interface BuiltInWords {
    /** The section's heading, "Built in". */
    readonly title: string;
    /** The row's button, "Open". */
    readonly open: string;
    /** The replaced products' list label, "Replaces". */
    readonly replaces: string;
}

/** The link a row is drawn with: the host's router link, a plain anchor otherwise. */
export type BuiltInLink = ComponentType<{
    href: string;
    className?: string;
    title?: string;
    children: ReactNode;
}>;

const Anchor: BuiltInLink = ({ children, ...props }) => <a {...props}>{children}</a>;

/**
 * The products an app replaces, as a row of their logos, each named in its
 * tooltip. `compact` is the built-in row's: logos only, smaller. The full one
 * names each product beside its logo.
 */
export function ReplacedLogos({
    items,
    label,
    compact = false,
    className
}: {
    items: readonly ReplacedLogo[];
    label: string;
    compact?: boolean;
    className?: string;
}) {
    if (items.length === 0) return null;
    const size = compact ? 20 : 28;
    return (
        <ul
            aria-label={label}
            className={cn(
                "flex min-w-0 flex-wrap items-center",
                compact ? "gap-1" : "gap-x-4 gap-y-2",
                className
            )}
        >
            {items.map((item) => (
                <li key={item.name} title={item.name} className="flex min-w-0 items-center gap-1.5">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a static SVG tile */}
                    <img
                        src={item.src}
                        alt={item.name}
                        width={size}
                        height={size}
                        className="shrink-0"
                        style={{ width: size, height: size }}
                    />
                    {compact ? null : (
                        <span aria-hidden="true" className="text-muted-foreground truncate text-sm">
                            {item.name}
                        </span>
                    )}
                </li>
            ))}
        </ul>
    );
}

export function BuiltInAppsSection({
    apps,
    words,
    link: Link = Anchor
}: {
    apps: readonly BuiltInApp[];
    words: BuiltInWords;
    link?: BuiltInLink;
}) {
    if (apps.length === 0) return null;
    return (
        <section className="flex min-w-0 flex-col gap-3" aria-label={words.title}>
            <h2 className="text-sm font-medium text-muted-foreground">{words.title}</h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {apps.map((app) => (
                    <div
                        key={app.id}
                        data-built-in={app.id}
                        className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
                    >
                        {/* The app's own logo, the tile the launcher shows. */}
                        <AppLogo
                            appId={app.id}
                            size={36}
                            className="shrink-0"
                            fallback={app.fallback}
                        />
                        <div className="min-w-0 flex-1">
                            <Link
                                href={app.href}
                                className="block truncate text-sm font-medium hover:underline"
                                title={app.label}
                            >
                                {app.label}
                            </Link>
                            {app.replaces.length > 0 ? (
                                <div className="mt-1.5 min-w-0">
                                    <ReplacedLogos
                                        items={app.replaces}
                                        label={words.replaces}
                                        compact
                                    />
                                </div>
                            ) : null}
                        </div>
                        <Button asChild size="sm" variant="secondary">
                            <Link href={app.href}>{words.open}</Link>
                        </Button>
                    </div>
                ))}
            </div>
        </section>
    );
}
