/**
 * The guided tours: which screens have one and which elements each step points at.
 *
 * Pure data and pure functions, so the registry can be checked in a test without a
 * browser. Steps name a `data-tour` attribute rather than a class, because classes
 * move with every restyle and a tour that silently points at nothing is worse
 * than no tour. The words live in the `tours` namespace under
 * `<tour>.steps.<step>.title|body`.
 */

export type TourSide = "top" | "right" | "bottom" | "left";

export interface TourStep {
    /** Key of the step's words in the `tours` namespace. */
    readonly key: string;
    /** Value of the `data-tour` attribute it points at. */
    readonly target: string;
    readonly side?: TourSide;
}

export interface Tour {
    readonly id: TourId;
    /** The screen the tour belongs to, or null when it runs on any screen. It is
     *  also the access check: a tour is offered only when its screen is one the
     *  reader's navigation reaches. */
    readonly href: string | null;
    readonly steps: readonly TourStep[];
}

export const TOUR_IDS = ["overview", "chat", "drive", "deploy", "games", "settings"] as const;
export type TourId = (typeof TOUR_IDS)[number];

/** The search parameter that starts a tour once its screen is open. */
export const TOUR_PARAM = "tour";

/** Where the first-run offer is remembered, in the per-account marks table. */
export const OVERVIEW_MARK_KEY = "tour.overview";
export const OVERVIEW_OUTCOMES = ["offered", "done", "skipped"] as const;
export type OverviewOutcome = (typeof OVERVIEW_OUTCOMES)[number];

export const TOURS: readonly Tour[] = [
    {
        id: "overview",
        href: null,
        steps: [
            { key: "switcher", target: "shell.switcher", side: "bottom" },
            { key: "menu", target: "shell.menu", side: "bottom" },
            { key: "search", target: "shell.search", side: "bottom" },
            { key: "sidebar", target: "shell.sidebar", side: "right" },
            { key: "notifications", target: "shell.notifications", side: "bottom" },
            { key: "account", target: "shell.account", side: "bottom" }
        ]
    },
    {
        id: "chat",
        href: "/chat",
        steps: [
            { key: "spaces", target: "chat.spaces", side: "right" },
            { key: "conversations", target: "chat.conversations", side: "right" },
            { key: "conversation", target: "chat.conversation", side: "left" }
        ]
    },
    {
        id: "drive",
        href: "/drive",
        steps: [
            { key: "locations", target: "drive.locations", side: "right" },
            { key: "search", target: "drive.search", side: "bottom" },
            { key: "upload", target: "drive.upload", side: "bottom" }
        ]
    },
    {
        id: "deploy",
        href: "/apps/deploy",
        steps: [
            { key: "create", target: "deploy.create", side: "bottom" },
            { key: "search", target: "deploy.search", side: "bottom" },
            { key: "sections", target: "shell.sidebar", side: "right" }
        ]
    },
    {
        id: "games",
        href: "/apps/games",
        steps: [
            { key: "create", target: "games.new", side: "bottom" },
            { key: "filters", target: "games.filters", side: "bottom" },
            { key: "list", target: "games.list", side: "top" }
        ]
    },
    {
        id: "settings",
        href: "/account",
        steps: [
            { key: "profile", target: "settings.profile", side: "bottom" },
            { key: "sections", target: "shell.sidebar", side: "right" },
            { key: "menu", target: "shell.menu", side: "bottom" },
            { key: "account", target: "shell.account", side: "bottom" }
        ]
    }
];

export function isTourId(value: unknown): value is TourId {
    return typeof value === "string" && (TOUR_IDS as readonly string[]).includes(value);
}

export function findTour(id: TourId): Tour {
    return TOURS.find((tour) => tour.id === id)!;
}

/** The selector a step's target answers to. */
export function tourSelector(target: string): string {
    return `[data-tour="${target}"]`;
}

/** The tours this reader can take: those that run anywhere, and those whose
 *  screen their navigation reaches - the same check the rail is drawn with. */
export function availableTours(reachable: ReadonlySet<string>): Tour[] {
    return TOURS.filter((tour) => tour.href === null || reachable.has(tour.href));
}

/** The address that opens a tour's screen and starts it there. */
export function tourHref(tour: Tour, currentPath: string): string {
    return `${tour.href ?? currentPath}?${TOUR_PARAM}=${tour.id}`;
}

/** Whether the reader is already on the tour's screen. */
export function onTourScreen(tour: Tour, pathname: string): boolean {
    return tour.href === null || pathname === tour.href || pathname.startsWith(`${tour.href}/`);
}

/**
 * The steps worth showing: those whose target is on screen and usable right now.
 * A step whose element a permission hid, a narrow screen tucked away, or that is
 * disabled for this reader is dropped rather than drawn as a popover pointing at
 * nothing.
 */
export function presentSteps(
    steps: readonly TourStep[],
    usable: (target: string) => boolean
): TourStep[] {
    return steps.filter((step) => usable(step.target));
}
