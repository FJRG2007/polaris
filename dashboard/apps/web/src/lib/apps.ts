/**
 * The Polaris app registry - what appears in the top-left switcher. Deliberately
 * small so the dashboard stays legible as it grows: Drive, the umbrella Apps
 * pillar (marketplace + everything Polaris installs and runs), and Management.
 * Everything installable lives under Apps rather than sprawling the switcher.
 */

import {
    Activity,
    Bell,
    Blocks,
    CalendarRange,
    ChartColumn,
    Clock,
    Contact,
    Container,
    Database,
    FileText,
    FolderOpen,
    Globe,
    HardDrive,
    Inbox,
    KeyRound,
    LayoutDashboard,
    LayoutGrid,
    Link2,
    ListTodo,
    Mail,
    MessagesSquare,
    MonitorSmartphone,
    Network,
    Radio,
    Rocket,
    ScrollText,
    Server,
    Settings,
    ShieldCheck,
    SlidersHorizontal,
    SquareCheckBig,
    Star,
    Store,
    Target,
    Timer,
    Trash2,
    UserCog,
    Users,
    UsersRound,
    Webhook,
    Workflow,
    type LucideIcon
} from "lucide-react";

export interface AppEntry {
    id: string;
    label: string;
    description: string;
    icon: LucideIcon;
    href: string;
    locked?: boolean;
    /** Only visible to administrators (filtered out of the switcher otherwise). */
    adminOnly?: boolean;
    /** Kept out of the switcher list: a personal section reached from the account
     *  menu, which still owns its paths so the rail and the header follow it. */
    hidden?: boolean;
    /** Extra path prefixes this app owns beyond `href`, so routes that live
     *  outside the app's own subtree (e.g. legacy top-level admin pages) still
     *  resolve to it for the switcher highlight and the sidebar. */
    match?: string[];
}

export const POLARIS_APPS: AppEntry[] = [
    {
        id: "drive",
        label: "Drive",
        description: "Files across every NAS",
        icon: HardDrive,
        href: "/drive"
    },
    {
        id: "apps",
        label: "Apps",
        description: "Install & run apps: deploys, servers, assistants",
        icon: LayoutGrid,
        // Deploy is the primary surface, so the app lands there rather than on the
        // marketplace.
        href: "/apps/deploy",
        // Owns the whole /apps subtree: the marketplace, installed-app dashboards,
        // and the built-in Deploy / Servers / Containers / Backups rails.
        match: ["/apps"]
    },
    {
        id: "tasks",
        label: "Tasks",
        description: "Plan and track work: spaces, lists, boards & goals",
        icon: SquareCheckBig,
        href: "/tasks"
    },
    {
        id: "inbox",
        label: "Inbox",
        description: "Customer conversations across every channel",
        icon: MessagesSquare,
        href: "/inbox"
    },
    {
        id: "watch",
        label: "Watch",
        description: "Alarms on app health, spikes and outages",
        icon: Activity,
        href: "/watch"
    },
    {
        id: "admin",
        label: "Management",
        description: "Users, access, domains & updates",
        icon: SlidersHorizontal,
        href: "/admin",
        adminOnly: true,
        // Admin pages that historically live at the top level, so they still
        // resolve to the Management app in the switcher and sidebar.
        match: ["/integrations", "/settings"]
    },
    {
        id: "account",
        label: "My account",
        description: "Profile, security & API keys",
        icon: UserCog,
        href: "/account",
        // Reached from the account menu, not the switcher.
        hidden: true
    }
];

export interface AppSection {
    label: string;
    href: string;
    icon: LucideIcon;
    /** Extra terms the global search matches on, for sections whose label is not
     *  what a user would think to type ("logs" for Activity, "2FA" for Security). */
    keywords?: string[];
    /** Reachable, but not one of the app's primary sections: kept out of the left
     *  rail while still being findable from search. */
    hidden?: boolean;
}

/**
 * The sections of each app, keyed by app id. Drives the left rail and the global
 * search index, so a page added here becomes navigable and findable at once.
 * Apps with no entry render no rail.
 */
export const APP_SECTIONS: Record<string, AppSection[]> = {
    drive: [
        { label: "Overview", href: "/drive/overview", icon: LayoutDashboard, keywords: ["usage", "storage"] },
        { label: "Files", href: "/drive", icon: FolderOpen, keywords: ["browse", "folders"] },
        { label: "Favorites", href: "/favorites", icon: Star, keywords: ["starred"] },
        { label: "Recent", href: "/drive/recent", icon: Clock },
        { label: "Shared links", href: "/drive/shared-links", icon: Link2, keywords: ["shares", "public"] },
        { label: "Drop points", href: "/drive/drop-points", icon: Inbox, keywords: ["file requests", "uploads"] },
        { label: "Trash", href: "/trash", icon: Trash2, keywords: ["deleted", "bin"] }
    ],
    apps: [
        { label: "Deploy", href: "/apps/deploy", icon: Rocket, keywords: ["projects", "services", "docker"] },
        { label: "Marketplace", href: "/apps/marketplace", icon: Store, keywords: ["install", "catalog"] },
        { label: "Servers", href: "/apps/servers", icon: Server, keywords: ["hosts", "machines", "ssh"] },
        { label: "Runners", href: "/apps/runners", icon: Workflow, keywords: ["github actions", "ci"] },
        {
            label: "Firewall",
            href: "/apps/firewall",
            icon: ShieldCheck,
            keywords: ["waf", "ip", "allowlist", "denylist", "block", "access"]
        },
        {
            label: "Analytics",
            href: "/apps/analytics",
            icon: ChartColumn,
            keywords: ["visitors", "traffic", "pageviews", "referrers", "metrics", "umami"]
        },
        { label: "Containers", href: "/apps/containers", icon: Container, keywords: ["docker"] },
        { label: "Backups", href: "/apps/backups", icon: Database, keywords: ["restore", "snapshots"] }
    ],
    watch: [
        { label: "Overview", href: "/watch", icon: LayoutDashboard, keywords: ["monitoring", "health"] },
        { label: "Servers", href: "/watch/servers", icon: Server, keywords: ["hosts", "machines", "load"] },
        { label: "Services", href: "/watch/services", icon: Rocket, keywords: ["apps", "deploys", "cpu", "memory"] },
        { label: "Containers", href: "/watch/containers", icon: Container, keywords: ["docker"] },
        { label: "Alarms", href: "/watch/alarms", icon: Bell, keywords: ["thresholds", "alerts", "events"] },
        { label: "Webhooks", href: "/watch/webhooks", icon: Webhook, keywords: ["discord", "slack", "endpoints"] }
    ],
    tasks: [
        { label: "My work", href: "/tasks", icon: ListTodo, keywords: ["home", "assigned", "todo", "my tasks"] },
        { label: "Everything", href: "/tasks/everything", icon: LayoutGrid, keywords: ["all tasks", "across spaces"] },
        { label: "Sprints", href: "/tasks/sprints", icon: CalendarRange, keywords: ["agile", "burndown", "iteration"] },
        { label: "Goals", href: "/tasks/goals", icon: Target, keywords: ["okr", "objectives", "targets"] },
        { label: "Docs", href: "/tasks/docs", icon: FileText, keywords: ["wiki", "notes", "knowledge"] },
        { label: "Timesheet", href: "/tasks/time", icon: Timer, keywords: ["time tracking", "hours", "billable"] },
        { label: "Reporting", href: "/tasks/reports", icon: ChartColumn, keywords: ["dashboard", "workload", "metrics"] }
    ],
    inbox: [
        { label: "Conversations", href: "/inbox", icon: MessagesSquare, keywords: ["chats", "messages"] },
        { label: "Contacts", href: "/inbox/contacts", icon: Contact, keywords: ["people"] },
        { label: "Channels", href: "/inbox/channels", icon: Radio, keywords: ["whatsapp", "telegram", "slack", "discord"] },
        { label: "Logs", href: "/inbox/logs", icon: ScrollText }
    ],
    account: [
        { label: "Profile", href: "/account", icon: UserCog, keywords: ["name", "email", "avatar"] },
        { label: "Preferences", href: "/account/preferences", icon: SlidersHorizontal, keywords: ["units", "language", "timezone"] },
        { label: "Notifications", href: "/account/notifications", icon: Bell, keywords: ["alerts", "email"] },
        { label: "Security", href: "/account/security", icon: ShieldCheck, keywords: ["password", "2fa", "two-factor", "passkey"] },
        { label: "Sessions", href: "/account/sessions", icon: MonitorSmartphone, keywords: ["devices", "sign out"] },
        { label: "Access rules", href: "/account/access", icon: Network, keywords: ["ip", "country", "geo"] },
        { label: "API keys", href: "/account/api-keys", icon: KeyRound, keywords: ["tokens"] }
    ],
    admin: [
        { label: "Overview", href: "/admin", icon: LayoutDashboard },
        { label: "Users", href: "/admin/users", icon: Users, keywords: ["accounts", "invites"] },
        { label: "Groups", href: "/admin/groups", icon: UsersRound, keywords: ["teams", "roles"] },
        { label: "Policies", href: "/admin/policies", icon: ShieldCheck, keywords: ["permissions", "access"] },
        { label: "Activity", href: "/admin/activity", icon: Activity, keywords: ["audit", "logs"] },
        { label: "Domains", href: "/admin/domains", icon: Globe, keywords: ["dns", "tunnels", "certificates"] },
        { label: "Email delivery", href: "/admin/email", icon: Mail, keywords: ["smtp", "sender"], hidden: true },
        { label: "Display defaults", href: "/admin/display", icon: SlidersHorizontal, keywords: ["units", "formats"] },
        {
            label: "Uploads",
            href: "/admin/uploads",
            icon: HardDrive,
            keywords: ["attachments", "files", "storage", "nas", "size limit"]
        },
        { label: "Integrations", href: "/integrations", icon: Blocks, keywords: ["github", "cloudflare", "connect"] },
        { label: "Updates & settings", href: "/settings", icon: Settings, keywords: ["version", "upgrade"] }
    ]
};

/** Whether a path belongs to an app: its own subtree, or one of its extra
 *  `match` prefixes (exact segment or a nested path under it). */
function appOwnsPath(app: AppEntry, pathname: string): boolean {
    const owns = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
    return owns(app.href) || (app.match?.some(owns) ?? false);
}

/** The app the current path belongs to, defaulting to the first app (Drive). */
export function resolveActiveApp(pathname: string): AppEntry {
    // POLARIS_APPS is a non-empty literal, so [0] is always present.
    return POLARIS_APPS.find((app) => appOwnsPath(app, pathname)) ?? POLARIS_APPS[0]!;
}

/**
 * Whether a section owns the path currently open, which is what the rail marks.
 *
 * A section normally covers everything below it, so a folder deep inside Drive
 * still shows Files as where you are. The exception is a section another one
 * sits underneath - "/tasks" with "/tasks/everything" below it - which would
 * otherwise stay lit on every screen of its app. Those match their own path
 * exactly, and which ones they are is read off the list rather than kept as a
 * second set somebody has to remember: the entry that gets forgotten there is
 * precisely the one that ends up wrongly highlighted.
 *
 * `sections` is the app's whole list, hidden entries included - a hidden page
 * still nests under a root and still decides the question.
 */
export function isSectionActive(pathname: string, href: string, sections: readonly AppSection[]): boolean {
    if (pathname === href) return true;
    if (sections.some((section) => section.href !== href && section.href.startsWith(`${href}/`))) return false;
    return pathname.startsWith(`${href}/`);
}
