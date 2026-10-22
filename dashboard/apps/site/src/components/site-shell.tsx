/**
 * The frame of every page: the document, the bar with the four pages and the
 * other language, and the footer pointing at the repository.
 */

import "../app/globals.css";
import Link from "next/link";
import type { ReactNode } from "react";
import type { SiteLocale } from "@/data/builders";
import { href, siteData, words } from "@/lib/site";
import { NavLink } from "@/components/nav-link";

const PAGES = [
    { key: "home", page: "" },
    { key: "marketplace", page: "marketplace/" },
    { key: "downloads", page: "downloads/" },
    { key: "api", page: "docs/api/" }
] as const;

export function SiteShell({ locale, children }: { locale: SiteLocale; children: ReactNode }) {
    const t = words(locale);
    const { repo } = siteData();
    const other: SiteLocale = locale === "en" ? "es" : "en";
    return (
        // "system": the dashboard's theme class that follows the reader's machine.
        <html lang={locale} className="system">
            <body className="min-h-screen bg-background text-foreground antialiased">
                <a
                    href="#main"
                    className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4"
                >
                    {t.nav.skip}
                </a>
                <header className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur">
                    <nav className="mx-auto flex max-w-6xl items-center gap-1 overflow-x-auto px-4 py-3 text-sm">
                        <Link
                            href={href(locale)}
                            className="mr-3 flex shrink-0 items-center gap-2 font-semibold"
                        >
                            Polaris
                        </Link>
                        {PAGES.slice(1).map((entry) => (
                            <NavLink
                                key={entry.key}
                                href={href(locale, entry.page)}
                                className="shrink-0 rounded-md px-2.5 py-1.5 text-muted-foreground hover:text-foreground aria-[current=page]:bg-surface aria-[current=page]:text-foreground"
                            >
                                {t.nav[entry.key]}
                            </NavLink>
                        ))}
                        <span className="flex-1" />
                        <Link
                            href={href(other)}
                            hrefLang={other}
                            className="shrink-0 px-2.5 py-1.5 text-muted-foreground hover:text-foreground"
                        >
                            {t.nav.language}
                        </Link>
                        <a
                            href={`https://github.com/${repo}`}
                            className="shrink-0 px-2.5 py-1.5 text-muted-foreground hover:text-foreground"
                        >
                            {t.nav.github}
                        </a>
                    </nav>
                </header>
                <main id="main" className="mx-auto flex max-w-6xl flex-col gap-12 px-4 py-10">
                    {children}
                </main>
                <footer className="border-t border-border">
                    <div className="mx-auto flex max-w-6xl flex-wrap justify-between gap-2 px-4 py-6 text-xs text-muted-foreground">
                        <span>{t.footer.license}</span>
                        <a className="underline" href={`https://github.com/${repo}`}>
                            {t.footer.source}
                        </a>
                    </div>
                </footer>
            </body>
        </html>
    );
}
