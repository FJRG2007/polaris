/**
 * The Polaris app registry - what appears in the top-left switcher. Deliberately
 * small so the dashboard stays legible as it grows: Drive, the umbrella Apps
 * pillar (marketplace + everything Polaris installs and runs), and Management.
 * Everything installable lives under Apps rather than sprawling the switcher.
 */

import type { OrgPermission, Permission } from "@polaris/core";
import {
    Activity,
    Bell,
    Bot,
    Blocks,
    BookOpen,
    Building2,
    CalendarRange,
    ChartColumn,
    Clock,
    Contact,
    Container,
    Database,
    FileText,
    FolderGit2,
    FolderOpen,
    Globe,
    HardDrive,
    History,
    IdCard,
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
    ScanLine,
    ScrollText,
    Server,
    Settings,
    ShieldCheck,
    SlidersHorizontal,
    Sparkles,
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
    /** The capability that opens this app. An account that does not hold it does
     *  not see the app in the switcher, is not offered its screens in search, and
     *  is turned away by every page inside it. An app with none is open to anyone
     *  signed in - only "My account" is. */
    permission?: Permission;
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
        href: "/drive",
        permission: "drive.read"
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
        match: ["/apps"],
        permission: "deploy.read"
    },
    {
        id: "tasks",
        label: "Tasks",
        description: "Plan and track work: spaces, lists, boards & goals",
        icon: SquareCheckBig,
        href: "/tasks",
        permission: "tasks.read"
    },
    {
        id: "inbox",
        label: "Inbox",
        description: "Customer conversations across every channel",
        icon: MessagesSquare,
        href: "/inbox",
        permission: "inbox.read"
    },
    {
        id: "watch",
        label: "Watch",
        description: "Alarms on app health, spikes and outages",
        icon: Activity,
        href: "/watch",
        permission: "deploy.read"
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
    /** The heading this sits under in the rail. Sections with none stay under the
     *  app's own heading, so a flat rail needs no groups at all; once one screen
     *  names a group, everything sharing that name is drawn together under it. */
    group?: string;
    /** For a rail whose entries are not all reachable by everybody looking at it:
     *  the organization permission this screen needs. Sections with none are open
     *  to anybody who can see the subject at all. */
    permission?: OrgPermission;
    /** Shown as well to somebody who may end the organization without running it -
     *  the successor its owner named. Deleting is deliberately not a permission,
     *  so it cannot be expressed as one above. */
    orgDeleter?: boolean;
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
            label: "Agents",
            href: "/apps/agents",
            icon: Bot,
            keywords: ["coding agent", "ai", "review", "pull requests", "issues", "github"]
        },
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
        { label: "Preferences", href: "/account/preferences", icon: SlidersHorizontal, keywords: ["units", "language", "timezone", "week start", "calendar"] },
        { label: "Notifications", href: "/account/notifications", icon: Bell, keywords: ["alerts", "email"] },
        {
            label: "Connected accounts",
            href: "/account/connections",
            icon: Link2,
            keywords: ["github", "google", "link", "oauth", "repositories", "calendar"]
        },
        {
            label: "AI provider keys",
            href: "/account/ai-keys",
            icon: Sparkles,
            keywords: [
                "byok",
                "bring your own key",
                "models",
                "anthropic",
                "claude",
                "openai",
                "gemini",
                "grok",
                "deepseek",
                "kimi",
                "groq",
                "cerebras",
                "openrouter",
                "provider",
                "billing",
                "agents"
            ]
        },
        {
            label: "Organizations",
            href: "/account/organizations",
            icon: Building2,
            keywords: ["org", "orgs", "teams", "company", "members", "roster", "group"]
        },
        {
            label: "Domains",
            href: "/account/domains",
            icon: Globe,
            keywords: ["dns", "custom domain", "deploys", "hostnames", "wildcard", "own domain"]
        },
        // Everything that decides who reaches this account is one subject, and it
        // is half the rail: six screens people go looking for together.
        {
            label: "Password & 2FA",
            href: "/account/security",
            icon: ShieldCheck,
            keywords: ["password", "2fa", "two-factor", "passkey", "security"],
            group: "Security"
        },
        {
            label: "Sessions",
            href: "/account/sessions",
            icon: MonitorSmartphone,
            keywords: ["devices", "sign out", "remembered devices", "trusted devices"],
            group: "Security"
        },
        {
            label: "Activity",
            href: "/account/activity",
            icon: History,
            keywords: ["audit", "logs", "history", "what happened"],
            group: "Security"
        },
        {
            label: "Scan a code",
            href: "/account/scan",
            icon: ScanLine,
            keywords: ["qr", "sign in", "approve", "camera"],
            group: "Security"
        },
        {
            label: "Access rules",
            href: "/account/access",
            icon: Network,
            keywords: ["ip", "country", "geo"],
            group: "Security"
        },
        { label: "API keys", href: "/account/api-keys", icon: KeyRound, keywords: ["tokens"], group: "Security" }
    ],
    admin: [
        { label: "Overview", href: "/admin", icon: LayoutDashboard },
        { label: "Users", href: "/admin/users", icon: Users, keywords: ["accounts", "invites"] },
        { label: "Groups", href: "/admin/groups", icon: UsersRound, keywords: ["teams"] },
        {
            label: "Organizations",
            href: "/admin/organizations",
            icon: Building2,
            keywords: ["org", "orgs", "teams", "company", "limits", "turn off"]
        },
        {
            label: "Roles",
            href: "/admin/roles",
            icon: IdCard,
            keywords: ["permissions", "member", "viewer", "guest", "what they can do", "capabilities", "view as"]
        },
        { label: "Policies", href: "/admin/policies", icon: ShieldCheck, keywords: ["permissions", "access"] },
        { label: "Activity", href: "/admin/activity", icon: Activity, keywords: ["audit", "logs"] },
        { label: "Domains", href: "/admin/domains", icon: Globe, keywords: ["dns", "tunnels", "certificates"] },
        { label: "Email delivery", href: "/admin/email", icon: Mail, keywords: ["smtp", "sender"], hidden: true },
        { label: "Display defaults", href: "/admin/display", icon: SlidersHorizontal, keywords: ["units", "formats"] },
        {
            label: "Agent defaults",
            href: "/admin/agents",
            icon: Bot,
            keywords: ["agents", "quality gate", "enigma", "public", "private", "pull requests", "issues"]
        },
        {
            label: "Uploads",
            href: "/admin/uploads",
            icon: HardDrive,
            keywords: ["attachments", "files", "storage", "nas", "size limit", "avatars", "profile photos", "gravatar"]
        },
        { label: "Integrations", href: "/integrations", icon: Blocks, keywords: ["github", "cloudflare", "connect"] },
        {
            label: "AI providers",
            href: "/integrations/models",
            icon: Sparkles,
            keywords: [
                "models",
                "anthropic",
                "claude",
                "openai",
                "gemini",
                "grok",
                "deepseek",
                "kimi",
                "groq",
                "cerebras",
                "openrouter",
                "api key",
                "agents"
            ]
        },
        { label: "Updates & settings", href: "/settings", icon: Settings, keywords: ["version", "upgrade"] }
    ]
};

/**
 * A section that grew into an app of its own.
 *
 * Most sections are one screen. A few are a whole subject with several: Runners
 * is pools, the repositories they serve, what has run, and the secrets those runs
 * can read - four screens that belong together and have nothing to say to the
 * rest of Apps. Listing them all in the Apps rail would bury Deploy and Servers
 * under one feature's internals, and hiding them behind one entry means nobody
 * finds Runs at all.
 *
 * So the rail follows the path down: inside one of these it shows that subject's
 * screens and a way back out, and everywhere else it is the app's own list. The
 * way back matters - a rail that swaps its contents without one is a place a
 * person gets stuck.
 */
export interface AppSubapp {
    /** The section id in APP_SECTIONS this replaces the rail for. */
    id: string;
    label: string;
    icon: LucideIcon;
    /** The path it owns, and where "back" comes back to. */
    base: string;
    parent: { label: string; href: string };
    sections: AppSection[];
}

export const APP_SUBAPPS: AppSubapp[] = [
    {
        id: "agents",
        label: "Agents",
        icon: Bot,
        base: "/apps/agents",
        parent: { label: "Apps", href: "/apps/deploy" },
        sections: [
            {
                label: "Overview",
                href: "/apps/agents",
                icon: LayoutDashboard,
                keywords: ["agents", "coding agent", "ai", "summary"]
            },
            {
                label: "Repositories",
                href: "/apps/agents/repos",
                icon: FolderGit2,
                keywords: ["repos", "enable", "where it runs", "model", "actions", "runners", "server"]
            },
            {
                label: "Automations",
                href: "/apps/agents/automations",
                icon: Workflow,
                keywords: ["triggers", "rules", "issue opened", "pull request", "review", "ci failed"]
            },
            {
                label: "Runs",
                href: "/apps/agents/runs",
                icon: History,
                keywords: ["history", "logs", "failed", "what happened"]
            },
            {
                label: "Settings",
                href: "/apps/agents/settings",
                icon: SlidersHorizontal,
                keywords: [
                    "defaults",
                    "organization",
                    "public",
                    "private",
                    "pull requests",
                    "issues",
                    "quality gate",
                    "enigma"
                ]
            },
            {
                label: "Set up",
                href: "/apps/agents/setup",
                icon: BookOpen,
                hidden: true,
                keywords: ["wizard", "getting started", "connect", "install"]
            }
        ]
    },
    {
        id: "runners",
        label: "Runners",
        icon: Workflow,
        base: "/apps/runners",
        parent: { label: "Apps", href: "/apps/deploy" },
        sections: [
            {
                label: "Pools",
                href: "/apps/runners",
                icon: Workflow,
                keywords: ["runners", "github actions", "ci", "machines", "self-hosted"]
            },
            {
                label: "Repositories",
                href: "/apps/runners/repos",
                icon: FolderGit2,
                keywords: ["repos", "who can run", "forks", "pull requests", "public", "private", "events"]
            },
            {
                label: "Runs",
                href: "/apps/runners/runs",
                icon: History,
                keywords: ["history", "jobs", "workflow runs", "builds", "logs", "failed"]
            },
            {
                label: "Secrets",
                href: "/apps/runners/secrets",
                icon: KeyRound,
                keywords: ["variables", "env", "credentials", "tokens", "passwords"]
            },
            {
                label: "How it works",
                href: "/apps/runners/guide",
                icon: BookOpen,
                keywords: ["help", "setup", "runs-on", "getting started", "guide", "docs"]
            }
        ]
    }
];

/** Where an organization's own screens live. */
export const ORG_BASE = "/account/organizations";

/**
 * The organization's rail, built for one handle.
 *
 * Not in APP_SUBAPPS because there is no fixed list of them: every organization
 * somebody belongs to is one, and its base is only known once a path names it.
 * Otherwise it behaves exactly like the others - it replaces the rail while you
 * are inside it, and the way back out is the list you came from.
 *
 * `permission` is what the rail hides an entry on. A member who cannot define
 * roles or add domains should not be shown two screens that will turn them away;
 * the entries with none are the ones everybody on the roster can open.
 */
export function orgSubapp(slug: string): AppSubapp {
    const base = `${ORG_BASE}/${slug}`;
    return {
        id: `org:${slug}`,
        // The handle rather than the name: the rail is drawn from the path alone,
        // and the organization's name is on the page it opens.
        label: `@${slug}`,
        icon: Building2,
        base,
        parent: { label: "Organizations", href: ORG_BASE },
        sections: [
            { label: "Overview", href: base, icon: LayoutDashboard, keywords: ["organization", "summary"] },
            {
                label: "People",
                href: `${base}/people`,
                icon: Users,
                keywords: ["members", "roster", "who", "invite", "add somebody"]
            },
            {
                label: "Teams",
                href: `${base}/teams`,
                icon: UsersRound,
                keywords: ["groups", "squads", "access", "grants"]
            },
            {
                label: "Roles",
                href: `${base}/roles`,
                icon: IdCard,
                permission: "roles.manage",
                keywords: ["permissions", "what they can do", "admin", "member"]
            },
            {
                label: "Spaces",
                href: `${base}/spaces`,
                icon: SquareCheckBig,
                keywords: ["tasks", "work", "boards", "lists", "projects"]
            },
            {
                label: "Domains",
                href: `${base}/domains`,
                icon: Globe,
                permission: "domains.manage",
                keywords: ["dns", "deploys", "hostnames", "custom domain", "wildcard"]
            },
            {
                label: "Activity",
                href: `${base}/activity`,
                icon: History,
                permission: "activity.read",
                keywords: ["audit", "history", "logs", "what happened", "who did"]
            },
            {
                label: "Settings",
                href: `${base}/settings`,
                icon: SlidersHorizontal,
                permission: "settings.manage",
                orgDeleter: true,
                keywords: ["name", "photo", "handle", "transfer", "delete", "hand over"]
            }
        ]
    };
}

/** The handle in an organization path, or null when the path is not inside one.
 *  The list itself is not: it is the way back out, so it must keep the account
 *  rail rather than swap to an organization's. */
export function orgSlugForPath(pathname: string): string | null {
    if (!pathname.startsWith(`${ORG_BASE}/`)) return null;
    const slug = pathname.slice(ORG_BASE.length + 1).split("/")[0] ?? "";
    return slug ? decodeURIComponent(slug) : null;
}

/** The subject a path is inside, or null when it is not inside one. */
export function resolveSubapp(pathname: string): AppSubapp | null {
    const slug = orgSlugForPath(pathname);
    if (slug) return orgSubapp(slug);
    return APP_SUBAPPS.find((sub) => pathname === sub.base || pathname.startsWith(`${sub.base}/`)) ?? null;
}

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
