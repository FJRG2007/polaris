/**
 * What each Overview card is called, what it costs to see, and how wide it may
 * be drawn.
 *
 * The vocabulary of card ids lives in @polaris/core, where the stored layout is
 * validated against it; this is the presentation half, and it is keyed by that
 * vocabulary so a card cannot be added to one without the other noticing.
 *
 * `permission` is the same capability the card's own screen requires, resolved
 * once on the server. A card nobody would be allowed to open is never drawn, and
 * never offered in the customize panel either - being shown a card you can turn
 * on and cannot read is worse than not being offered it.
 */

import type { Permission } from "@polaris/core";
import type { OverviewWidgetId, OverviewWidgetSize } from "@polaris/core";
import {
    Activity,
    Bell,
    Clock,
    Gamepad2,
    HardDrive,
    LayoutGrid,
    ListTodo,
    Rocket,
    ScrollText,
    Star,
    ChartColumn,
    MonitorSmartphone,
    type LucideIcon
} from "lucide-react";

export interface OverviewWidgetEntry {
    id: OverviewWidgetId;
    label: string;
    /** One line in the customize panel: what the card is for. */
    description: string;
    icon: LucideIcon;
    /** The capability that opens it. Cards with none are for everybody signed in. */
    permission?: Permission;
    /** Where the card's own screen is, for its "open" link. Null for the cards
     *  that are not a shortcut to anywhere - the pinned links are the whole of
     *  themselves, and so is the launcher. */
    href: string | null;
    /** Widths this card is legible at. A sparkline row needs the width; a counter
     *  does not, and stretching one across the grid only wastes the row. */
    sizes: readonly OverviewWidgetSize[];
    /** It reads its own data in the browser (the feed, this browser's history, or
     *  the account's own preferences) rather than from /api/overview. */
    local?: boolean;
    /** Something that has to exist on this instance before the card means
     *  anything, on top of the permission. A card about game servers on an
     *  instance that runs none is an empty card teaching nobody anything. */
    requires?: OverviewFeature;
}

/** The things a card can depend on being present, answered once on the server. */
export type OverviewFeature = "games";

/** Which of those this account actually has. A feature absent from the record is
 *  treated as absent, so a new one is off until something answers for it. */
export type OverviewFeatures = Partial<Record<OverviewFeature, boolean>>;

const ALL_SIZES = ["sm", "md", "lg"] as const;

export const OVERVIEW_WIDGETS: readonly OverviewWidgetEntry[] = [
    {
        id: "shortcuts",
        label: "Quick access",
        description: "The pages and services you pinned yourself.",
        icon: Star,
        href: null,
        sizes: ["md", "lg"],
        local: true
    },
    {
        id: "services",
        label: "Services",
        description: "What is deployed and running, and what stopped.",
        icon: Rocket,
        permission: "deploy.read",
        href: "/apps/deploy",
        sizes: ALL_SIZES
    },
    {
        id: "usage",
        label: "Usage",
        description: "CPU and memory on the machines you run things on.",
        icon: ChartColumn,
        permission: "deploy.read",
        href: "/watch/servers",
        sizes: ALL_SIZES
    },
    {
        id: "notifications",
        label: "Notifications",
        description: "The latest alerts, newest first.",
        icon: Bell,
        href: "/account/notifications",
        sizes: ALL_SIZES,
        local: true
    },
    {
        id: "recent",
        label: "Recently visited",
        description: "Where you have been in Polaris, on this device.",
        icon: Clock,
        href: null,
        sizes: ALL_SIZES,
        local: true
    },
    {
        id: "tasks",
        label: "My work",
        description: "Tasks assigned to you, and what is overdue.",
        icon: ListTodo,
        permission: "tasks.read",
        href: "/tasks",
        sizes: ALL_SIZES
    },
    {
        id: "alarms",
        label: "Alarms",
        description: "Alarms firing now, and what tripped recently.",
        icon: Activity,
        permission: "deploy.read",
        href: "/watch/alarms",
        sizes: ALL_SIZES
    },
    {
        id: "storage",
        label: "Storage",
        description: "How full each connected device is.",
        icon: HardDrive,
        permission: "drive.read",
        href: "/drive/overview",
        sizes: ALL_SIZES
    },
    {
        id: "apps",
        label: "Your apps",
        description: "Every app this account can open.",
        icon: LayoutGrid,
        href: null,
        sizes: ALL_SIZES,
        local: true
    },
    {
        id: "games",
        label: "Game servers",
        description: "Which of your servers are up, and how full they are.",
        icon: Gamepad2,
        permission: "games.read",
        href: "/apps/games",
        sizes: ALL_SIZES,
        // Nobody who has never installed one wants a card about them, and being
        // offered it in the customize panel is being told to go and find out what
        // it would show.
        requires: "games"
    },
    {
        id: "sessions",
        label: "Signed in",
        description: "The devices your account is open on right now.",
        icon: MonitorSmartphone,
        // No permission: it is this account's own sessions, which is the one thing
        // every account may read about itself.
        href: "/account/sessions",
        sizes: ALL_SIZES
    },
    {
        id: "activity",
        label: "Recent activity",
        description: "What was done with your account, and from where.",
        icon: ScrollText,
        href: "/account/activity",
        sizes: ALL_SIZES
    }
];

const BY_ID = new Map(OVERVIEW_WIDGETS.map((widget) => [widget.id, widget]));

export function overviewWidget(id: OverviewWidgetId): OverviewWidgetEntry {
    // Ids come from the schema's own enum, so every one of them is in the map.
    return BY_ID.get(id)!;
}

/** Whether a stored size is one this card is legible at, for a layout written
 *  before the card's sizes were narrowed (or written by hand). */
export function overviewSize(id: OverviewWidgetId, size: OverviewWidgetSize): OverviewWidgetSize {
    const entry = overviewWidget(id);
    return entry.sizes.includes(size) ? size : (entry.sizes[0] ?? "md");
}

export interface OverviewAccessInput {
    isAdmin: boolean;
    can: (permission: Permission) => Promise<boolean>;
    /** What this instance has that a card can be about. Omitted is the same as
     *  having none of it. */
    features?: OverviewFeatures;
}

/**
 * The cards this account may see, in catalogue order.
 *
 * Both tests have to pass and they answer different questions: the permission is
 * whether this account is allowed to know, the feature is whether there is
 * anything to know. Losing the permission takes the card away from somebody who
 * had it - which is the point - while the feature only ever decides whether it is
 * offered at all, so uninstalling the last game server does not delete how
 * somebody had arranged theirs.
 */
export async function availableOverviewWidgets({ can, features }: OverviewAccessInput): Promise<OverviewWidgetId[]> {
    const decided = await Promise.all(
        OVERVIEW_WIDGETS.map(async (widget) => {
            if (widget.requires && features?.[widget.requires] !== true) return null;
            return !widget.permission || (await can(widget.permission)) ? widget.id : null;
        })
    );
    return decided.filter((id): id is OverviewWidgetId => id !== null);
}
