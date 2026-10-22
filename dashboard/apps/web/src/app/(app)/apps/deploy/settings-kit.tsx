"use client";

/**
 * The building blocks of a service's Settings tab: a section with its heading,
 * one card per setting group, the save row at the foot of a card, and the
 * navigator that keeps the sections one click away.
 *
 * Railway draws a service's settings as titled sections stacked down the panel;
 * Vercel draws each setting as a card with its title, a line of description, the
 * control, and a footer holding the Save button. This is both: sections to find
 * your way, cards so one group never runs into the next, and a Save per card that
 * stays off until that card holds a real change - so pressing it never sends
 * what is already stored, and a card saved says so where the reader is looking.
 */

import { Button, Card, cn, Input, Skeleton } from "@polaris/ui";
import { activeSection, sameSettings, withFields } from "./settings-form";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { filterSettings, type SettingsIndex } from "./settings-search";
import { Check, ChevronRight, Loader2, Search, X, type LucideIcon } from "lucide-react";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode
} from "react";

/** One entry of the navigator: the section it scrolls to. */
export interface SettingsSectionLink {
    readonly id: string;
    readonly label: string;
    readonly icon: LucideIcon;
    readonly danger?: boolean;
    /** The section key its cards declare in the page's index (the id when absent). */
    readonly group?: string;
}

/** What "Filter settings" has narrowed the page to, for the cards and sections
 *  under it. `visible` is null while nothing is typed. */
interface SettingsFilterState {
    readonly visible: { cards: Set<string>; sections: Set<string> } | null;
    readonly register: (entry: string, text: string) => () => void;
}

const SettingsFilterContext = createContext<SettingsFilterState | null>(null);

/** Puts a card in the filter's reach by its entry id and the words it shows, and
 *  says whether the filter hides it. Outside a filtered layout it never does. */
function useFilteredOut(entry: string | undefined, text: string): boolean {
    const filter = useContext(SettingsFilterContext);
    const register = filter?.register;
    useEffect(() => {
        if (!register || !entry) return;
        return register(entry, text);
    }, [register, entry, text]);
    if (!filter?.visible || !entry) return false;
    return !filter.visible.cards.has(entry);
}

/** The words of a title or description that is plain text; a composed one
 *  is found by its declared keywords instead. */
function plainText(...nodes: ReactNode[]): string {
    return nodes.filter((node) => typeof node === "string" || typeof node === "number").join(" ");
}

/** Whether a key press is the "/" that jumps to the filter, rather than a
 *  slash typed into a field. */
function isFilterShortcut(event: KeyboardEvent): boolean {
    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return false;
    const target = event.target as HTMLElement | null;
    if (!target) return true;
    const tag = target.tagName;
    return !(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable);
}

/** How long "Saved" stays beside a card's Save button. */
const SAVED_MS = 3000;

/** The nearest ancestor that scrolls: the panel body the sections live in. */
function scrollerOf(node: HTMLElement | null): HTMLElement | null {
    let current = node?.parentElement ?? null;
    while (current) {
        const overflow = getComputedStyle(current).overflowY;
        if (overflow === "auto" || overflow === "scroll") return current;
        current = current.parentElement;
    }
    return null;
}

function reducedMotion(): boolean {
    return (
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    );
}

/**
 * The sections with a navigator beside them (a row of chips above them on a
 * phone). It follows the scroll: the section being read is the one marked.
 */
export function SettingsLayout({
    sections: allSections,
    index,
    children
}: {
    sections: readonly SettingsSectionLink[];
    /** Every card's section and keywords: given, the page gets "Filter settings". */
    index?: SettingsIndex;
    children: ReactNode;
}) {
    const t = useTranslations("deployService");
    const content = useRef<HTMLDivElement>(null);
    const nav = useRef<HTMLUListElement>(null);
    const search = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState("");
    const [mounted, setMounted] = useState<ReadonlyMap<string, string>>(new Map());
    const register = useCallback((entry: string, text: string) => {
        setMounted((current) =>
            current.get(entry) === text ? current : new Map(current).set(entry, text)
        );
        return () =>
            setMounted((current) => {
                if (!current.has(entry)) return current;
                const next = new Map(current);
                next.delete(entry);
                return next;
            });
    }, []);
    const filtering = Boolean(index) && query.trim() !== "";
    const visible = useMemo(
        () =>
            filtering && index
                ? filterSettings(
                      index,
                      [...mounted].map(([entry, text]) => ({ entry, text })),
                      query
                  )
                : null,
        [filtering, index, mounted, query]
    );
    const filter = useMemo<SettingsFilterState | null>(
        () => (index ? { visible, register } : null),
        [index, visible, register]
    );
    // The rail lists only the sections the filter leaves something in.
    const sections = visible
        ? allSections.filter((section) => visible.sections.has(section.group ?? section.id))
        : allSections;
    const [current, setCurrent] = useState<string | null>(sections[0]?.id ?? null);
    const jumped = useRef<string | null>(null);
    const ids = sections.map((section) => section.id).join(",");

    // "/" anywhere on the page jumps to the filter, as on Railway and GitHub.
    useEffect(() => {
        if (!index) return;
        const onKey = (event: KeyboardEvent) => {
            if (!isFilterShortcut(event)) return;
            event.preventDefault();
            search.current?.focus();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [index]);

    useEffect(() => {
        const scroller = scrollerOf(content.current);
        if (!scroller) return;
        let frame = 0;
        const measure = () => {
            frame = 0;
            const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
            const tops = ids
                .split(",")
                .map((id) => document.getElementById(id))
                .filter((node): node is HTMLElement => node !== null)
                .map((node) => ({ id: node.id, top: node.getBoundingClientRect().top - base }));
            const reading = activeSection(
                tops,
                scroller.scrollTop,
                scroller.clientHeight,
                scroller.scrollHeight
            );
            // A section picked from the navigator stays marked while the scroll it
            // started runs, and after it when the end of the tab stopped it short -
            // a short last section never reaches the reading line.
            setCurrent(jumped.current ?? reading);
        };
        const release = () => {
            jumped.current = null;
        };
        const onScroll = () => {
            if (!frame) frame = requestAnimationFrame(measure);
        };
        measure();
        scroller.addEventListener("scroll", onScroll, { passive: true });
        // The reader taking over the scroll hands the marker back to it.
        for (const kind of ["wheel", "touchstart", "keydown", "pointerdown"] as const) {
            scroller.addEventListener(kind, release, { passive: true });
        }
        // Cards finish loading after the first measure and push the sections down.
        const resize = new ResizeObserver(onScroll);
        if (content.current) resize.observe(content.current);
        return () => {
            scroller.removeEventListener("scroll", onScroll);
            for (const kind of ["wheel", "touchstart", "keydown", "pointerdown"] as const) {
                scroller.removeEventListener(kind, release);
            }
            resize.disconnect();
            if (frame) cancelAnimationFrame(frame);
        };
    }, [ids]);

    // On a phone the chips scroll sideways: keep the current one in sight
    // without moving the page under it.
    useEffect(() => {
        const list = nav.current;
        const chip = list?.querySelector<HTMLElement>('[aria-current="true"]');
        if (!list || !chip || list.scrollWidth <= list.clientWidth) return;
        const left =
            chip.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft;
        if (
            left < list.scrollLeft ||
            left + chip.offsetWidth > list.scrollLeft + list.clientWidth
        ) {
            list.scrollTo({
                left: Math.max(0, left - 16),
                behavior: reducedMotion() ? "auto" : "smooth"
            });
        }
    }, [current]);

    const jump = useCallback((id: string) => {
        const target = document.getElementById(id);
        const scroller = scrollerOf(content.current);
        if (!target || !scroller) return;
        // Below the chip row on a phone, which stays pinned over the content.
        const pinned =
            nav.current &&
            getComputedStyle(nav.current.parentElement!).position === "sticky" &&
            window.innerWidth < 640
                ? nav.current.parentElement!.getBoundingClientRect().height
                : 0;
        const top =
            target.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top +
            scroller.scrollTop -
            pinned -
            8;
        jumped.current = id;
        scroller.scrollTo({ top, behavior: reducedMotion() ? "auto" : "smooth" });
        setCurrent(id);
        // The heading takes focus, so the keyboard carries on from the section.
        target.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
    }, []);

    return (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
            <nav
                aria-label={t("kit.sections")}
                className="sticky -top-4 z-10 -mx-5 -mt-4 sm:top-0 border-b border-border bg-background px-5 py-2 sm:mx-0 sm:mt-0 sm:w-44 sm:shrink-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-2"
            >
                <ul
                    ref={nav}
                    className="no-scrollbar flex gap-1 overflow-x-auto sm:flex-col sm:overflow-visible"
                >
                    {sections.map((section) => {
                        const Icon = section.icon;
                        const active = section.id === current;
                        return (
                            <li key={section.id} className="shrink-0">
                                <button
                                    type="button"
                                    onClick={() => jump(section.id)}
                                    aria-current={active ? "true" : undefined}
                                    className={cn(
                                        "flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-left text-[0.8125rem] transition-colors duration-fast",
                                        active
                                            ? "bg-muted font-medium text-foreground"
                                            : "text-muted-foreground hover:bg-card-hover hover:text-foreground"
                                    )}
                                >
                                    <Icon
                                        className={cn(
                                            "size-4 shrink-0",
                                            section.danger
                                                ? "text-danger-ink"
                                                : active
                                                  ? "text-foreground"
                                                  : "text-foreground-subtle"
                                        )}
                                        aria-hidden
                                    />
                                    {section.label}
                                </button>
                            </li>
                        );
                    })}
                </ul>
            </nav>
            <div ref={content} className="flex min-w-0 flex-1 flex-col gap-10 pb-16 sm:pt-1">
                {index && (
                    <div className="-mb-6 flex flex-col gap-3">
                        <div className="relative">
                            <Search
                                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle"
                                aria-hidden
                            />
                            <Input
                                ref={search}
                                type="search"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Escape" && query) {
                                        event.preventDefault();
                                        setQuery("");
                                    }
                                }}
                                placeholder={t("kit.filterPlaceholder")}
                                aria-label={t("kit.filterLabel")}
                                aria-keyshortcuts="/"
                                className="pl-8 pr-9"
                            />
                            <kbd
                                className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-border px-1.5 font-mono text-[0.6875rem] text-foreground-subtle sm:block"
                                aria-hidden
                            >
                                /
                            </kbd>
                        </div>
                        {visible && visible.cards.size === 0 && (
                            <div
                                role="status"
                                className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-center"
                            >
                                <p className="min-w-0 break-words text-sm font-medium">
                                    {t("kit.filterEmpty", { query: query.trim() })}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {t("kit.filterEmptyHint")}
                                </p>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                        setQuery("");
                                        search.current?.focus();
                                    }}
                                >
                                    <X aria-hidden /> {t("kit.filterClear")}
                                </Button>
                            </div>
                        )}
                    </div>
                )}
                <SettingsFilterContext.Provider value={filter}>
                    {children}
                </SettingsFilterContext.Provider>
            </div>
        </div>
    );
}

/** One titled section of the tab: an icon, a heading, one line on what is in it,
 *  and its cards. */
export function SettingsSection({
    id,
    group,
    icon: Icon,
    title,
    intro,
    danger,
    children
}: {
    id: string;
    /** The section key its cards declare in the page's index (the id when absent). */
    group?: string;
    icon: LucideIcon;
    title: string;
    intro: string;
    danger?: boolean;
    children: ReactNode;
}) {
    const filter = useContext(SettingsFilterContext);
    // Hidden rather than unmounted, so a card's unsaved edit survives a search.
    const hidden = Boolean(filter?.visible && !filter.visible.sections.has(group ?? id));
    return (
        <section
            id={id}
            aria-labelledby={`${id}-title`}
            hidden={hidden}
            className={cn("flex flex-col gap-3", hidden && "!hidden")}
        >
            <header className="flex items-start gap-3">
                <span
                    className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-md border",
                        danger
                            ? "border-danger-edge bg-danger-soft text-danger-ink"
                            : "border-border bg-card text-muted-foreground"
                    )}
                    aria-hidden
                >
                    <Icon className="size-4" />
                </span>
                <div className="flex min-w-0 flex-col gap-0.5">
                    <h2
                        id={`${id}-title`}
                        tabIndex={-1}
                        className={cn(
                            "text-[0.9375rem] font-semibold tracking-tight",
                            danger && "text-danger-ink"
                        )}
                    >
                        {title}
                    </h2>
                    <p className="text-xs text-muted-foreground">{intro}</p>
                </div>
            </header>
            <div className="flex flex-col gap-3">{children}</div>
        </section>
    );
}

/**
 * One setting group: title, one line of description, the controls, the longer
 * explanation folded under "Learn more", and an optional footer that holds the
 * card's Save.
 */
export function SettingsCard({
    id,
    entry,
    title,
    description,
    badge,
    actions,
    learnMore,
    footer,
    danger,
    busy,
    children
}: {
    id?: string;
    /** Its id in the page's settings index, which "Filter settings" finds it by. */
    entry?: string;
    title: ReactNode;
    description?: ReactNode;
    /** A status chip beside the title. */
    badge?: ReactNode;
    /** Controls on the title's line, right-aligned (wrapped under it when narrow). */
    actions?: ReactNode;
    learnMore?: ReactNode;
    footer?: ReactNode;
    danger?: boolean;
    busy?: boolean;
    children?: ReactNode;
}) {
    const hidden = useFilteredOut(entry, plainText(title, description));
    return (
        <Card
            id={id}
            hidden={hidden}
            aria-busy={busy || undefined}
            className={cn(
                "flex min-w-0 scroll-mt-16 flex-col",
                danger && "border-danger-edge",
                hidden && "!hidden"
            )}
        >
            <div className="flex min-w-0 flex-col gap-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                    <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
                        <h3 className="flex flex-wrap items-center gap-2 text-[0.8125rem] font-semibold leading-5">
                            {title}
                            {badge}
                        </h3>
                        {description && (
                            <p className="text-xs text-muted-foreground">{description}</p>
                        )}
                    </div>
                    {actions && (
                        <div className="flex max-w-full flex-wrap items-center gap-2">
                            {actions}
                        </div>
                    )}
                </div>
                {children}
                {learnMore && <LearnMore>{learnMore}</LearnMore>}
            </div>
            {footer && (
                <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 rounded-b-lg border-t border-border bg-surface px-4 py-2.5">
                    {footer}
                </div>
            )}
        </Card>
    );
}

/** The detail behind a card's one-line description, folded until asked for. */
export function LearnMore({ children }: { children: ReactNode }) {
    const t = useTranslations("deployService");
    return (
        <details className="group text-xs">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-muted-foreground transition-colors duration-fast hover:text-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRight
                    className="size-3.5 shrink-0 transition-transform duration-fast group-open:rotate-90"
                    aria-hidden
                />
                {t("kit.learnMore")}
            </summary>
            <div className="mt-1.5 flex flex-col gap-1.5 pl-[1.125rem] text-muted-foreground">
                {children}
            </div>
        </details>
    );
}

/**
 * The row at the foot of a card: what state the card is in, Discard while it
 * holds a change, and Save. Save is blocked (aria-disabled, so its reason stays
 * reachable by keyboard) until the values differ from the saved ones and pass
 * their check; after a save it says "Saved" until the next edit.
 */
export function SaveBar({
    dirty,
    pending,
    justSaved,
    invalid,
    error,
    label,
    busy,
    onSave,
    onDiscard
}: {
    dirty: boolean;
    pending: boolean;
    justSaved: boolean;
    invalid?: string | null;
    error?: string | null;
    label?: string;
    /** Another card that shares this one's server write is saving. */
    busy?: boolean;
    onSave: () => void;
    onDiscard?: () => void;
}) {
    const t = useTranslations("deployService");
    const blocked = !dirty || Boolean(invalid) || pending || Boolean(busy);
    return (
        <>
            <p className="mr-auto min-w-0 text-xs" role="status" aria-live="polite">
                {error ? (
                    <span className="text-danger-ink">{error}</span>
                ) : dirty && invalid ? (
                    <span className="text-danger-ink">{invalid}</span>
                ) : justSaved && !dirty ? (
                    <span className="inline-flex items-center gap-1 text-success-ink">
                        <Check className="size-3.5 shrink-0" aria-hidden /> {t("kit.saved")}
                    </span>
                ) : dirty ? (
                    <span className="text-warning-ink">{t("kit.unsaved")}</span>
                ) : null}
            </p>
            {dirty && onDiscard && (
                <Button variant="ghost" size="sm" onClick={onDiscard} disabled={pending || busy}>
                    {t("kit.discard")}
                </Button>
            )}
            <Button
                size="sm"
                aria-disabled={blocked}
                title={!dirty ? t("kit.noChanges") : (invalid ?? undefined)}
                onClick={() => {
                    if (!blocked) onSave();
                }}
                className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            >
                {pending && <Loader2 className="animate-spin" aria-hidden />}
                {label ?? t("kit.save")}
            </Button>
        </>
    );
}

/**
 * A form's values: what is stored, what is on screen, and whether they differ -
 * for the whole form, or for the fields one card of it shows. Several cards can
 * share one server write: each saves `next(itsFields)` (its own edits over what
 * is stored for the rest) and `commit`s that, so a neighbour's pending edit is
 * neither sent nor lost, and only the card that saved says "Saved".
 */
export function useCardForm<T extends object>(initial: T) {
    const [saved, setSaved] = useState(initial);
    const [draft, setDraft] = useState(initial);
    const [flash, setFlash] = useState<string | null>(null);
    const all = Object.keys(initial) as (keyof T)[];

    useEffect(() => {
        if (!flash) return;
        const timer = setTimeout(() => setFlash(null), SAVED_MS);
        return () => clearTimeout(timer);
    }, [flash]);

    const pick = (value: T, keys: readonly (keyof T)[]) => keys.map((key) => value[key]);

    return {
        saved,
        draft,
        patch: (next: Partial<T>) => setDraft((current) => ({ ...current, ...next })),
        dirty: (keys: readonly (keyof T)[] = all) =>
            !sameSettings(pick(draft, keys), pick(saved, keys)),
        next: (keys: readonly (keyof T)[] = all) => withFields(saved, draft, keys),
        commit: (next: T, card = "all") => {
            setSaved(next);
            setFlash(card);
        },
        justSaved: (card = "all") => flash === card,
        discard: (keys: readonly (keyof T)[] = all) =>
            setDraft((current) => withFields(current, saved, keys))
    };
}

/** "Saved" for a few seconds after a save, for cards that keep their own state. */
export function useSavedFlash(): [boolean, () => void] {
    const [at, setAt] = useState(0);
    useEffect(() => {
        if (!at) return;
        const timer = setTimeout(() => setAt(0), SAVED_MS);
        return () => clearTimeout(timer);
    }, [at]);
    return [at > 0, () => setAt(Date.now())];
}

/** A card's shape while its data is on the way. */
export function CardSkeleton({
    entry,
    title,
    rows = 2
}: {
    /** The entry of the card it stands in for, so the filter treats it the same. */
    entry?: string;
    title?: ReactNode;
    rows?: number;
}) {
    const hidden = useFilteredOut(entry, plainText(title));
    return (
        <Card
            aria-busy="true"
            hidden={hidden}
            className={cn("flex flex-col gap-3 p-4", hidden && "!hidden")}
        >
            {title ? (
                <h3 className="text-[0.8125rem] font-semibold leading-5">{title}</h3>
            ) : (
                <Skeleton className="h-4 w-36" />
            )}
            <Skeleton className="h-3 w-64 max-w-full" />
            {Array.from({ length: rows }, (_, index) => (
                <Skeleton key={index} className="h-8 w-full" />
            ))}
        </Card>
    );
}

/** A card whose data could not be read: why, and the way to ask again. */
export function CardError({
    entry,
    title,
    message,
    onRetry
}: {
    /** The entry of the card that failed to load, so the filter treats it the same. */
    entry?: string;
    title?: ReactNode;
    message: string;
    onRetry?: () => void;
}) {
    const t = useTranslations("deployService");
    const hidden = useFilteredOut(entry, plainText(title));
    return (
        <Card hidden={hidden} className={cn("flex flex-col gap-2 p-4", hidden && "!hidden")}>
            {title && <h3 className="text-[0.8125rem] font-semibold leading-5">{title}</h3>}
            <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="min-w-0 text-danger-ink">{message}</span>
                {onRetry && (
                    <Button size="xs" variant="outline" onClick={onRetry}>
                        {t("kit.retry")}
                    </Button>
                )}
            </div>
        </Card>
    );
}
