/**
 * The frame of every page: the document, the bar with the site's pages and the
 * language picker, and the footer pointing at the repository.
 */

import "../app/globals.css";
import Link from "next/link";
import type { ReactNode } from "react";
import type { SiteLocale } from "@/data/builders";
import { sans } from "@/lib/fonts";
import { href, siteData, words } from "@/lib/site";
import { NavLink } from "@/components/nav-link";
import { LanguagePicker } from "@/components/language-picker";
import { GitHubMark } from "@polaris/ui/account-downloads/brand-icons";

const PAGES = [
    { key: "home", page: "" },
    { key: "marketplace", page: "marketplace/" },
    { key: "downloads", page: "downloads/" },
    { key: "docs", page: "docs/" },
    { key: "api", page: "docs/api/" },
    { key: "roadmap", page: "docs/roadmap/" }
] as const;

export function SiteShell({ locale, children }: { locale: SiteLocale; children: ReactNode }) {
    const t = words(locale);
    const { repo } = siteData();
    return (
        // "system": the dashboard's theme class that follows the reader's machine.
        <html lang={locale} className={`system ${sans.variable}`}>
            <body className="min-h-screen bg-background text-foreground antialiased">
                <a
                    href="#main"
                    className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4"
                >
                    {t.nav.skip}
                </a>
                <header className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur">
                    <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-1 px-4 py-3 text-sm">
                        <Link
                            href={href(locale)}
                            className="mr-3 flex shrink-0 items-center gap-2 font-semibold"
                        >
                            Polaris
                        </Link>
                        {/* On a phone the pages take a row of their own, under the name and the two links. */}
                        <div className="order-last -mx-2.5 flex w-[calc(100%+1.25rem)] min-w-0 flex-wrap gap-1 sm:order-none sm:mx-0 sm:w-auto">
                            {PAGES.slice(1).map((entry) => (
                                <NavLink
                                    key={entry.key}
                                    href={href(locale, entry.page)}
                                    section={entry.key === "docs"}
                                    except={[
                                        href(locale, "docs/api/"),
                                        href(locale, "docs/roadmap/")
                                    ]}
                                    className="shrink-0 rounded-md px-2.5 py-1.5 text-muted-foreground hover:text-foreground aria-[current=page]:bg-surface aria-[current=page]:text-foreground"
                                >
                                    {t.nav[entry.key]}
                                </NavLink>
                            ))}
                        </div>
                        <span className="flex-1" />
                        <LanguagePicker
                            locale={locale}
                            label={t.nav.language}
                            search={t.nav.languageSearch}
                            empty={t.nav.languageEmpty}
                        />
                        <a
                            href={`https://github.com/${repo}`}
                            aria-label={t.nav.github}
                            title={t.nav.github}
                            className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground"
                        >
                            <GitHubMark className="size-5" />
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
