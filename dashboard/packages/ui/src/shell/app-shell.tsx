/**
 * The dashboard chrome: a slim top bar carrying the app switcher on the left and
 * account/edition controls on the right, an optional left navigation rail, and
 * the scrolling content area. Kept presentational and responsive - on narrow
 * viewports the rail moves into a drawer behind the header's menu button, and
 * the bar sheds the wordmark and the search field before its controls collide;
 * callers supply the actual nav and account menu.
 */

import { cn } from "../lib/cn";
import type { ReactNode } from "react";

export function AppShell({
    mark,
    switcher,
    navButton,
    search,
    account,
    sidebar,
    children
}: {
    /** The wordmark in the top-left. Callers pass it wrapped in their router's
     *  link so pressing it goes home the way a logo does everywhere else; the
     *  bare mark is the fallback for chrome with nowhere to go. */
    mark?: ReactNode;
    switcher: ReactNode;
    /** Opens the rail on viewports too narrow to show it beside the content
     *  (see MobileNav). Callers pass nothing for a section-less app. */
    navButton?: ReactNode;
    /** Global search, centered in the top bar. */
    search?: ReactNode;
    account: ReactNode;
    sidebar?: ReactNode;
    children: ReactNode;
}) {
    return (
        <div className="relative flex min-h-screen flex-col bg-background">
            <header className="sticky top-0 z-40 flex h-header shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-3 sm:gap-4 sm:px-4">
                <div className="flex min-w-0 items-center gap-1.5 sm:gap-3">
                    {navButton}
                    {mark ?? <PolarisMark className="shrink-0" nameClassName="hidden sm:inline" />}
                    {switcher}
                    {/* Pages portal contextual controls here (e.g. the Deploy project +
                        environment selectors), to the right of the app switcher. */}
                    <div id="polaris-header-slot" className="flex min-w-0 items-center gap-1 sm:gap-2" />
                </div>
                {/* The field only earns the middle of the bar once it renders as a
                    field; below that it is an icon and sits with the account controls. */}
                {search ? <div className="flex min-w-0 shrink-0 justify-end px-0 lg:flex-1 lg:shrink lg:justify-center lg:px-2">{search}</div> : null}
                <div className="flex shrink-0 items-center gap-1 sm:gap-2">{account}</div>
            </header>
            <div className="flex flex-1">
                {sidebar ? (
                    // Pinned under the sticky header and scrolling on its own, so the rail
                    // stays reachable however far down the content the user is. An app
                    // with no sections renders nothing, and `empty:hidden` keeps that
                    // from leaving a bare column beside the content.
                    <aside className="sticky top-header hidden h-below-header w-56 shrink-0 self-start overflow-y-auto border-r border-border bg-surface p-2 empty:hidden md:block">
                        {sidebar}
                    </aside>
                ) : null}
                {/* `--page-inset` is main's own vertical padding, published so a
                    page that wants to fill the viewport can subtract it without
                    hard-coding numbers that live here. See PAGE_FILL. */}
                <main className="min-w-0 flex-1 p-3 [--page-inset:1.5rem] sm:p-4 sm:[--page-inset:2rem] md:px-6 md:py-5 md:[--page-inset:2.5rem]">
                    {children}
                </main>
            </div>
        </div>
    );
}

/**
 * A screen that fills what is left of the window and scrolls inside itself.
 *
 * For the handful of screens that are a workspace rather than a document - a
 * conversation with its composer pinned at the bottom, a terminal, a file
 * browser with its own panes. Everything else scrolls the page, which is right
 * for a page.
 *
 * The height is the viewport less the header less main's own padding, and that
 * last term is why this lives here: a page that did the arithmetic itself would
 * be silently a few pixels too tall the day the shell's padding changed, and the
 * symptom - a composer just below the fold, a scrollbar on the window as well as
 * on the list - reads as a layout bug in the page rather than as the coupling it
 * is.
 *
 * Height and clipping only. It deliberately does not say `flex` or a direction:
 * a caller that wanted rows would have to override a direction set here, and two
 * Tailwind classes for the same property do not resolve by the order they are
 * written in the attribute - they resolve by stylesheet order, so the override
 * silently loses and a two-column screen comes out stacked.
 */
export const PAGE_FILL = "h-[calc(100vh-var(--header-height)-var(--page-inset))] overflow-hidden";

/**
 * A screen that fills what is left of the window edge to edge, with no margin
 * around it at all.
 *
 * For the one shape of screen that is not a page: an application inside the
 * application, with its own rails, its own headers and its own panels, each of
 * which draws its own border. Chat is that - and inside a page's padding it read
 * as a picture of a chat client pasted onto a page, with a strip of unused
 * background above it, below it and down both sides while its own panels ran out
 * of room.
 *
 * The negative margins are exactly `main`'s padding, which is why they are
 * written here beside it rather than in the screen that uses them: two sets of
 * numbers in two files drift, and the symptom is a one-sided gap nobody can
 * account for. A screen using this must not also be `w-full` - a block box with
 * auto width absorbs the negative margins and grows into them, and a fixed width
 * would push the same distance off the right-hand edge instead.
 */
export const PAGE_BLEED =
    "-m-3 h-[calc(100vh-var(--header-height))] overflow-hidden sm:-m-4 md:-mx-6 md:-my-5";

/** The Polaris wordmark: the star glyph plus the name. `nameClassName` lets a
 *  cramped bar drop the name and keep the glyph.
 *
 *  The glyph is drawn in the accent colour rather than set on a gradient tile:
 *  the star IS the mark, and a coloured square behind every logo is the house
 *  style of no house in particular. */
export function PolarisMark({ className, nameClassName }: { className?: string; nameClassName?: string }) {
    return (
        <span className={cn("flex items-center gap-2", className)}>
            <svg viewBox="0 0 24 24" className="size-[18px] shrink-0 text-primary" fill="currentColor" aria-hidden="true">
                <path d="M12 2l1.9 6.6L20 10l-6.1 1.4L12 18l-1.9-6.6L4 10l6.1-1.4L12 2z" />
            </svg>
            <span className={cn("text-[0.8125rem] font-semibold tracking-tight", nameClassName)}>Polaris</span>
        </span>
    );
}

/** A page heading block for content areas. The title is the largest thing on the
 *  screen and the only one at that size; everything under it is body text. */
export function PageHeader({
    title,
    description,
    actions
}: {
    title: string;
    description?: string;
    actions?: ReactNode;
}) {
    return (
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
                <h1 className="text-[1.0625rem] font-semibold leading-tight tracking-tight">{title}</h1>
                {description ? (
                    <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted-foreground">{description}</p>
                ) : null}
            </div>
            {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
    );
}
