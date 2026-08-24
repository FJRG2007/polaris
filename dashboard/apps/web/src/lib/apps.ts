/**
 * The Polaris app registry - what appears in the top-left switcher. Deliberately
 * small so the dashboard stays legible as it grows: Drive, the umbrella Apps
 * pillar (marketplace + everything Polaris installs and runs), and Management.
 * Everything installable lives under Apps rather than sprawling the switcher.
 */

import type { OrgPermission, Permission } from "@polaris/core";
import {
    Activity,
    Archive,
    Bell,
    Bot,
    Blocks,
    BookOpen,
    Building2,
    CalendarRange,
    Camera,
    Cctv,
    ChartColumn,
    CalendarClock,
    Clock,
    Code2,
    Contact,
    Container,
    Database,
    EyeOff,
    FileText,
    FolderGit2,
    FolderOpen,
    Gamepad2,
    GitPullRequest,
    Globe,
    HardDrive,
    History,
    House,
    IdCard,
    Inbox,
    KeyRound,
    LayoutDashboard,
    LayoutGrid,
    Link2,
    ListTodo,
    Mail,
    Flag,
    MessageCircle,
    MessageSquare,
    MessagesSquare,
    MonitorSmartphone,
    Network,
    NotebookPen,
    Radio,
    Rocket,
    ScanFace,
    ScanLine,
    Scale,
    ScrollText,
    SendHorizontal,
    Server,
    Settings,
    ShieldCheck,
    SlidersHorizontal,
    Sparkles,
    SquareCheckBig,
    Star,
    Store,
    Target,
    Terminal,
    Timer,
    Trash2,
    UserCog,
    BadgeCheck,
    Users,
    UsersRound,
    Video,
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
    /**
     * A subject an admin-only app carries that is not administration, for the
     * people whose work it is.
     *
     * Management owns Inbox: the channels conversations arrive on are instance
     * configuration, but the conversations themselves are a member's daily work,
     * and `member` and `viewer` both hold `inbox.read`. Without this they would
     * lose the door to it the moment Inbox stopped being an app of its own. So an
     * account holding the permission sees the app under this name and lands here;
     * every administration screen behind it stays shut by its own guard.
     */
    guest?: { permission: Permission; href: string; label: string; description: string };
    /** Kept out of the switcher list: a personal section reached from the account
     *  menu, which still owns its paths so the rail and the header follow it. */
    hidden?: boolean;
    /**
     * The marketplace app whose install turns this one on, for an app that is a
     * feature somebody opts into rather than part of every Polaris.
     *
     * Holding the permission is not enough on its own: until the app is installed
     * there is nothing behind the entry, and a switcher full of doors onto empty
     * rooms is how a dashboard stops meaning anything. Resolved by the caller
     * (see reachableApps) - an entry with none is always offered.
     */
    requiresApp?: string;
    /** Extra path prefixes this app owns beyond `href`, so routes that live
     *  outside the app's own subtree (e.g. legacy top-level admin pages) still
     *  resolve to it for the switcher highlight and the sidebar. */
    match?: string[];
}

/** The landing screen's own app id. It is the one app whose rail is the others. */
export const OVERVIEW_APP_ID = "overview";

export const POLARIS_APPS: AppEntry[] = [
    {
        id: OVERVIEW_APP_ID,
        label: "Overview",
        description: "Your services, usage and shortcuts at a glance",
        icon: LayoutDashboard,
        // /home rather than /overview: that path spent a release redirecting to
        // Drive's overview, permanently, and a browser that followed it once keeps
        // doing so from its own cache however the server is configured afterwards.
        href: "/home"
        // No permission: it is a view onto whatever the account can already
        // reach, so it shows what that is and nothing more. An account that
        // reaches nothing does not get it either - see reachableApps.
    },
    {
        id: "drive",
        label: "Drive",
        description: "Files across every NAS",
        icon: HardDrive,
        href: "/drive",
        // Two of its sections live at the top level rather than under /drive, so
        // they are named here: without them the switcher and the rail fall back
        // to whichever app happens to be first in this list.
        match: ["/favorites", "/trash"],
        permission: "drive.read"
    },
    {
        id: "vault",
        label: "Vault",
        description: "Passwords, keys and secrets, encrypted in your browser",
        icon: KeyRound,
        href: "/vault",
        permission: "vault.use"
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
        /**
         * The places you own and what watches them.
         *
         * Its own app rather than a screen inside Apps, because the people who
         * watch a camera are rarely the people who deploy anything - and it is
         * only here at all once somebody installs it.
         *
         * The id stays `home` however it is labelled: it is the catalog app
         * people have already installed, and renaming it would orphan every one
         * of those installs to rename a word on screen.
         */
        id: "home",
        label: "Places",
        description: "Your places and the cameras in them, what they saw, and what to do about it",
        icon: House,
        // Never "/home": that path belongs to Overview and spent a release
        // redirecting permanently to Drive, so browsers that followed it once
        // still do.
        href: "/places",
        permission: "home.read",
        requiresApp: "home"
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
        id: "chat",
        label: "Chat",
        description: "Channels, direct messages and calls with the people here",
        icon: MessageCircle,
        href: "/chat",
        permission: "chat.use"
    },
    {
        id: "notes",
        label: "Notes",
        description: "Write things down, nested the way a notebook is",
        icon: NotebookPen,
        href: "/notes",
        permission: "notes.use"
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
        // resolve to the Management app in the switcher and sidebar, plus Inbox,
        // which is a subject of Management rather than an app beside it.
        match: ["/inbox", "/integrations", "/settings"],
        guest: {
            permission: "inbox.read",
            href: "/inbox",
            label: "Inbox",
            description: "Customer conversations across every channel"
        }
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
/**
 * The two headings the Apps rail is read under.
 *
 * Ten entries in one flat list is ten things to read every time you are looking
 * for one, and they are not ten of a kind: four are things you run, three are the
 * machines they run on, three are how you watch and protect them. The rail groups
 * them so the eye lands on the third of the list it wants.
 */
/**
 * The heading the camera screens sit under in the Home rail.
 *
 * Home is the house, and cameras are the first thing in it rather than the whole
 * of it - so they are named as a subject from the start. A flat rail of six
 * camera screens would have to be rearranged the day anything else arrives, and
 * rearranging a rail people have learned is a worse cost than one heading now.
 */
const CAMERAS_GROUP = "Cameras";

const MACHINES_GROUP = "Machines";
const OPERATIONS_GROUP = "Operations";

/**
 * The heading the account's privacy screens are read under.
 *
 * Three screens that are one subject: the rules by audience, the people they
 * name, and the hours that answer the same question by the clock instead. Given
 * a heading for the reason the security screens have one - somebody arrives
 * looking for "who can see me", not for the particular screen it happens to be
 * on, and a flat rail makes them read all eleven entries to find out.
 */
const PRIVACY_GROUP = "Privacy";

/**
 * The headings the Management rail is read under.
 *
 * Fifteen entries in one list is a wall, and an operator arrives at it with one
 * of four questions: who is here, what they may do, how Polaris reaches people,
 * and how the deployment itself is set up. Overview and Activity stay ungrouped
 * at the top, because they are where you look before you know which of the four
 * you want.
 */
const ADMIN_PEOPLE_GROUP = "People";
const ADMIN_ACCESS_GROUP = "Access";
const ADMIN_COMMUNICATION_GROUP = "Communication";
const ADMIN_PLATFORM_GROUP = "Platform";

export const APP_SECTIONS: Record<string, AppSection[]> = {
    drive: [
        {
            label: "Overview",
            href: "/drive/overview",
            icon: LayoutDashboard,
            keywords: ["usage", "storage"]
        },
        { label: "Files", href: "/drive", icon: FolderOpen, keywords: ["browse", "folders"] },
        { label: "Favorites", href: "/favorites", icon: Star, keywords: ["starred"] },
        { label: "Recent", href: "/drive/recent", icon: Clock },
        {
            label: "Shared links",
            href: "/drive/shared-links",
            icon: Link2,
            keywords: ["shares", "public"]
        },
        {
            label: "Snippets",
            href: "/drive/snippets",
            icon: Code2,
            keywords: ["paste", "pastebin", "code", "text", "env", "secret", "gist", "share text"]
        },
        {
            label: "Drop points",
            href: "/drive/drop-points",
            icon: Inbox,
            keywords: ["file requests", "uploads", "ask for text", "collect"]
        },
        { label: "Trash", href: "/trash", icon: Trash2, keywords: ["deleted", "bin"] }
    ],
    vault: [
        {
            label: "Items",
            href: "/vault",
            icon: KeyRound,
            keywords: [
                "passwords",
                "logins",
                "notes",
                "cards",
                "identities",
                "ssh keys",
                "bitwarden"
            ]
        },
        {
            label: "Vaults",
            href: "/vault/vaults",
            icon: Building2,
            keywords: [
                "second vault",
                "another vault",
                "organization",
                "team",
                "collection",
                "share passwords",
                "shared vault",
                "colleagues",
                "members"
            ]
        },
        {
            label: "Sends",
            href: "/vault/sends",
            icon: SendHorizontal,
            keywords: ["share a secret", "one time", "send", "hand over"]
        },
        {
            label: "Connect an app",
            href: "/vault/clients",
            icon: MonitorSmartphone,
            keywords: ["bitwarden", "browser extension", "cli", "desktop", "mobile", "sync"]
        },
        {
            label: "Settings",
            href: "/vault/settings",
            icon: SlidersHorizontal,
            keywords: ["master password", "kdf", "argon2", "export", "delete vault"]
        }
    ],
    apps: [
        {
            label: "Deploy",
            href: "/apps/deploy",
            icon: Rocket,
            keywords: ["projects", "services", "docker"]
        },
        {
            label: "Marketplace",
            href: "/apps/marketplace",
            icon: Store,
            keywords: ["install", "catalog"]
        },
        {
            label: "Game servers",
            href: "/apps/games",
            icon: Gamepad2,
            keywords: [
                "minecraft",
                "java",
                "bedrock",
                "ark",
                "survival evolved",
                "players",
                "console",
                "rcon",
                "mods",
                "plugins"
            ]
        },
        {
            label: "Servers",
            href: "/apps/servers",
            icon: Server,
            group: MACHINES_GROUP,
            keywords: ["hosts", "machines", "ssh"]
        },
        {
            label: "Runners",
            href: "/apps/runners",
            icon: Workflow,
            group: MACHINES_GROUP,
            keywords: ["github actions", "ci"]
        },
        {
            label: "Agents",
            href: "/apps/agents",
            icon: Bot,
            keywords: ["coding agent", "ai", "review", "pull requests", "issues", "github"]
        },
        {
            label: "Code",
            href: "/apps/code",
            icon: GitPullRequest,
            keywords: [
                "pull requests",
                "prs",
                "issues",
                "review",
                "merge",
                "github",
                "waiting on me",
                "assigned to me"
            ]
        },
        {
            label: "Firewall",
            href: "/apps/firewall",
            icon: ShieldCheck,
            group: OPERATIONS_GROUP,
            keywords: ["waf", "ip", "allowlist", "denylist", "block", "access"]
        },
        {
            label: "Analytics",
            href: "/apps/analytics",
            icon: ChartColumn,
            group: OPERATIONS_GROUP,
            keywords: ["visitors", "traffic", "pageviews", "referrers", "metrics", "umami"]
        },
        {
            label: "Databases",
            href: "/apps/databases",
            icon: Database,
            group: OPERATIONS_GROUP,
            keywords: [
                "sql",
                "query",
                "postgres",
                "postgresql",
                "mysql",
                "mariadb",
                "mongo",
                "mongodb",
                "redis",
                "tables",
                "rows",
                "browse",
                "client"
            ]
        },
        {
            label: "Containers",
            href: "/apps/containers",
            icon: Container,
            group: MACHINES_GROUP,
            keywords: ["docker"]
        },
        {
            label: "Backups",
            href: "/apps/backups",
            icon: Archive,
            group: OPERATIONS_GROUP,
            keywords: ["restore", "snapshots"]
        }
    ],
    watch: [
        {
            label: "Overview",
            href: "/watch",
            icon: LayoutDashboard,
            keywords: ["monitoring", "health"]
        },
        {
            label: "Servers",
            href: "/watch/servers",
            icon: Server,
            keywords: ["hosts", "machines", "load"]
        },
        {
            label: "Services",
            href: "/watch/services",
            icon: Rocket,
            keywords: ["apps", "deploys", "cpu", "memory"]
        },
        { label: "Containers", href: "/watch/containers", icon: Container, keywords: ["docker"] },
        {
            label: "Alarms",
            href: "/watch/alarms",
            icon: Bell,
            keywords: ["thresholds", "alerts", "events"]
        },
        {
            label: "Webhooks",
            href: "/watch/webhooks",
            icon: Webhook,
            keywords: ["discord", "slack", "endpoints"]
        }
    ],
    home: [
        {
            label: "Live",
            href: "/places",
            icon: Cctv,
            group: CAMERAS_GROUP,
            keywords: ["cameras", "wall", "watch", "stream", "view", "rtsp"]
        },
        {
            label: "Events",
            group: CAMERAS_GROUP,
            href: "/places/events",
            icon: Bell,
            keywords: [
                "detections",
                "motion",
                "person",
                "faces",
                "alerts",
                "what happened",
                "history"
            ]
        },
        {
            label: "Alerts",
            group: CAMERAS_GROUP,
            href: "/places/alerts",
            icon: Bell,
            keywords: ["notify", "tell me", "warn", "rules", "who gets told", "message"]
        },
        {
            label: "Clips",
            group: CAMERAS_GROUP,
            href: "/places/clips",
            icon: Video,
            keywords: ["recordings", "footage", "playback", "saved", "download"]
        },
        {
            label: "Cameras",
            group: CAMERAS_GROUP,
            href: "/places/cameras",
            icon: Camera,
            keywords: [
                "add camera",
                "tapo",
                "tp-link",
                "onvif",
                "discover",
                "credentials",
                "detection",
                "recording"
            ]
        },
        {
            label: "People",
            group: CAMERAS_GROUP,
            href: "/places/people",
            icon: ScanFace,
            keywords: ["faces", "known", "recognition", "family", "strangers"]
        },
        {
            label: "Settings",
            href: "/places/settings",
            icon: SlidersHorizontal,
            keywords: ["relay", "storage", "retention", "where it runs", "uninstall"]
        }
    ],
    tasks: [
        {
            label: "My work",
            href: "/tasks",
            icon: ListTodo,
            keywords: ["home", "assigned", "todo", "my tasks"]
        },
        {
            label: "Everything",
            href: "/tasks/everything",
            icon: LayoutGrid,
            keywords: ["all tasks", "across spaces"]
        },
        {
            label: "Sprints",
            href: "/tasks/sprints",
            icon: CalendarRange,
            keywords: ["agile", "burndown", "iteration"]
        },
        {
            label: "Goals",
            href: "/tasks/goals",
            icon: Target,
            keywords: ["okr", "objectives", "targets"]
        },
        {
            label: "Docs",
            href: "/tasks/docs",
            icon: FileText,
            keywords: ["wiki", "notes", "knowledge"]
        },
        {
            label: "Timesheet",
            href: "/tasks/time",
            icon: Timer,
            keywords: ["time tracking", "hours", "billable"]
        },
        {
            label: "Reporting",
            href: "/tasks/reports",
            icon: ChartColumn,
            keywords: ["dashboard", "workload", "metrics"]
        }
    ],
    notes: [
        {
            label: "Notes",
            href: "/notes",
            icon: NotebookPen,
            keywords: ["notepad", "scratch", "jot", "personal", "private", "markdown", "writing"]
        },
        {
            label: "Archive",
            href: "/notes/archive",
            icon: Archive,
            keywords: ["archived", "put away", "old notes", "restore"]
        }
    ],
    account: [
        {
            label: "Profile",
            href: "/account",
            icon: UserCog,
            keywords: ["name", "email", "avatar"]
        },
        {
            label: "Account standing",
            href: "/account/standing",
            icon: BadgeCheck,
            keywords: ["moderation", "warnings", "suspended", "reports", "timeout", "ban", "rules"]
        },
        {
            label: "Preferences",
            href: "/account/preferences",
            icon: SlidersHorizontal,
            keywords: ["units", "language", "timezone", "week start", "calendar"]
        },
        // Who sees what, in one place: the rules by audience, the people those
        // rules name, and the hours that answer the same question by the clock.
        {
            label: "Privacy",
            href: "/account/privacy",
            icon: EyeOff,
            keywords: [
                "read receipts",
                "ticks",
                "last seen",
                "online",
                "avatar",
                "photo",
                "friends",
                "blocked"
            ],
            group: PRIVACY_GROUP
        },
        {
            label: "Status schedule",
            href: "/account/privacy/schedule",
            icon: CalendarClock,
            keywords: [
                "invisible",
                "do not disturb",
                "away",
                "quiet hours",
                "sleep",
                "night",
                "working hours",
                "presence",
                "automatic",
                "recurring",
                "every day",
                "weekdays"
            ],
            group: PRIVACY_GROUP
        },
        {
            label: "Friends",
            href: "/account/friends",
            icon: Users,
            keywords: ["friend", "request", "add somebody", "contacts"],
            group: PRIVACY_GROUP
        },
        {
            label: "Notifications",
            href: "/account/notifications",
            icon: Bell,
            keywords: ["alerts", "email"]
        },
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
        {
            label: "API keys",
            href: "/account/api-keys",
            icon: KeyRound,
            keywords: ["tokens"],
            group: "Security"
        }
    ],
    admin: [
        { label: "Overview", href: "/admin", icon: LayoutDashboard },
        { label: "Activity", href: "/admin/activity", icon: Activity, keywords: ["audit", "logs"] },
        {
            label: "Users",
            href: "/admin/users",
            icon: Users,
            keywords: ["accounts", "invites"],
            group: ADMIN_PEOPLE_GROUP
        },
        {
            label: "Groups",
            href: "/admin/groups",
            icon: UsersRound,
            keywords: ["teams"],
            group: ADMIN_PEOPLE_GROUP
        },
        {
            label: "Organizations",
            href: "/admin/organizations",
            icon: Building2,
            keywords: ["org", "orgs", "teams", "company", "limits", "turn off"],
            group: ADMIN_PEOPLE_GROUP
        },
        {
            label: "Roles",
            href: "/admin/roles",
            icon: IdCard,
            keywords: [
                "permissions",
                "member",
                "viewer",
                "guest",
                "what they can do",
                "capabilities",
                "view as"
            ],
            group: ADMIN_ACCESS_GROUP
        },
        {
            label: "Policies",
            href: "/admin/policies",
            icon: Scale,
            keywords: ["permissions", "access"],
            group: ADMIN_ACCESS_GROUP
        },
        {
            label: "Security",
            href: "/admin/security",
            icon: ShieldCheck,
            keywords: [
                "2fa",
                "two-factor",
                "two-step",
                "authenticator",
                "require",
                "mandatory",
                "sign-in",
                "enrolment",
                "enrollment"
            ],
            group: ADMIN_ACCESS_GROUP
        },
        {
            label: "Inbox",
            href: "/inbox",
            icon: MessagesSquare,
            keywords: [
                "conversations",
                "chats",
                "messages",
                "whatsapp",
                "telegram",
                "slack",
                "contacts"
            ],
            group: ADMIN_COMMUNICATION_GROUP
        },
        {
            label: "Email",
            href: "/admin/email",
            icon: Mail,
            keywords: [
                "smtp",
                "sender",
                "resend",
                "brevo",
                "mailjet",
                "ses",
                "outgoing",
                "account mail"
            ],
            group: ADMIN_COMMUNICATION_GROUP
        },
        {
            label: "Chat",
            href: "/admin/chat",
            icon: MessageSquare,
            keywords: [
                "messages",
                "limits",
                "edit history",
                "delete",
                "attachments",
                "rate limit",
                "direct messages",
                "group chats",
                "calls",
                "call server",
                "video calls",
                "meetings"
            ],
            group: ADMIN_COMMUNICATION_GROUP
        },
        {
            label: "Reported messages",
            href: "/admin/reports",
            icon: Flag,
            keywords: ["reports", "moderation", "abuse", "spam", "flagged", "chat"],
            group: ADMIN_COMMUNICATION_GROUP
        },
        {
            label: "Domains",
            href: "/admin/domains",
            icon: Globe,
            keywords: ["dns", "tunnels", "certificates"],
            group: ADMIN_PLATFORM_GROUP
        },
        {
            label: "Display defaults",
            href: "/admin/display",
            icon: SlidersHorizontal,
            keywords: ["units", "formats"],
            group: ADMIN_PLATFORM_GROUP
        },
        {
            label: "Agent defaults",
            href: "/admin/agents",
            icon: Bot,
            keywords: [
                "agents",
                "quality gate",
                "enigma",
                "public",
                "private",
                "pull requests",
                "issues"
            ],
            group: ADMIN_PLATFORM_GROUP
        },
        {
            label: "Uploads",
            href: "/admin/uploads",
            icon: HardDrive,
            keywords: [
                "attachments",
                "files",
                "storage",
                "nas",
                "size limit",
                "avatars",
                "profile photos",
                "gravatar"
            ],
            group: ADMIN_PLATFORM_GROUP
        },
        {
            label: "Integrations",
            href: "/integrations",
            icon: Blocks,
            keywords: ["github", "cloudflare", "connect"],
            group: ADMIN_PLATFORM_GROUP
        },
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
            ],
            group: ADMIN_PLATFORM_GROUP
        },
        {
            label: "Updates & settings",
            href: "/settings",
            icon: Settings,
            keywords: ["version", "upgrade"],
            group: ADMIN_PLATFORM_GROUP
        }
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
    /** The app "back" returns to, when not everybody who reaches this subject can
     *  open it. Inbox is Management's, and a member holds `inbox.read` without
     *  holding anything else in Management - so for them the way back is a door
     *  that refuses them, and the rail leaves it out rather than drawing it. */
    parentAppId?: string;
    sections: AppSection[];
}

export const APP_SUBAPPS: AppSubapp[] = [
    {
        id: "inbox",
        label: "Inbox",
        icon: MessagesSquare,
        base: "/inbox",
        parent: { label: "Management", href: "/admin" },
        parentAppId: "admin",
        sections: [
            {
                label: "Conversations",
                href: "/inbox",
                icon: MessagesSquare,
                keywords: ["chats", "messages"]
            },
            { label: "Contacts", href: "/inbox/contacts", icon: Contact, keywords: ["people"] },
            {
                label: "Channels",
                href: "/inbox/channels",
                icon: Radio,
                keywords: ["whatsapp", "telegram", "slack", "discord"]
            },
            { label: "Logs", href: "/inbox/logs", icon: ScrollText }
        ]
    },
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
                keywords: [
                    "repos",
                    "enable",
                    "where it runs",
                    "model",
                    "actions",
                    "runners",
                    "server"
                ]
            },
            {
                label: "Automations",
                href: "/apps/agents/automations",
                icon: Workflow,
                keywords: [
                    "triggers",
                    "rules",
                    "issue opened",
                    "pull request",
                    "review",
                    "ci failed"
                ]
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
                keywords: [
                    "repos",
                    "who can run",
                    "forks",
                    "pull requests",
                    "public",
                    "private",
                    "events"
                ]
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

/** Where an installed app's own screens live. */
export const INSTALLED_BASE = "/apps/installed";

const RUNNING_GROUP = "Running it";
const CONTENT_GROUP = "What is on it";
const ACCESS_GROUP = "Who gets in";

/**
 * How each of a game server's screens is drawn in the rail, by the slug the
 * server's own tab bar uses for it.
 *
 * The tab bar is a row of nine and reads as one undifferentiated row. They are
 * not nine of a kind - one is the server itself, three are what is happening on
 * it, three are what is on it, two are who may touch it - and the rail has the
 * room to say so. What is in this map is presentation; which of them a viewer
 * gets is decided on the server.
 */
const GAME_RAIL: Readonly<Record<string, Omit<AppSection, "href">>> = {
    "": {
        label: "Overview",
        icon: LayoutDashboard,
        keywords: ["status", "address", "players online"]
    },
    console: {
        label: "Console",
        icon: Terminal,
        group: RUNNING_GROUP,
        keywords: ["commands", "rcon", "logs", "say"]
    },
    players: {
        label: "Players",
        icon: Users,
        group: RUNNING_GROUP,
        keywords: ["who is on", "kick", "ban", "op", "inventory", "give item"]
    },
    usage: {
        label: "Usage",
        icon: ChartColumn,
        group: RUNNING_GROUP,
        keywords: ["cpu", "memory", "history", "metrics"]
    },
    world: {
        label: "World",
        icon: Globe,
        group: CONTENT_GROUP,
        keywords: ["level", "seed", "backups", "restore", "new world"]
    },
    rules: {
        label: "Rules",
        icon: Scale,
        group: CONTENT_GROUP,
        keywords: [
            "gamerule",
            "keep inventory",
            "keepinventory",
            "respawn",
            "difficulty",
            "mob griefing",
            "fire spread",
            "daylight",
            "weather"
        ]
    },
    mods: {
        label: "Mods",
        icon: Blocks,
        group: CONTENT_GROUP,
        keywords: ["plugins", "datapacks", "modrinth", "fabric", "forge"]
    },
    access: {
        label: "Access",
        icon: IdCard,
        group: ACCESS_GROUP,
        keywords: ["invite", "who can manage", "moderator", "grants"]
    },
    security: {
        label: "Security",
        icon: ShieldCheck,
        group: ACCESS_GROUP,
        keywords: ["whitelist", "bans", "firewall", "addresses"]
    },
    settings: {
        label: "Settings",
        icon: SlidersHorizontal,
        keywords: ["server.properties", "memory", "version", "restart", "uninstall"]
    }
};

/** What the rail needs to know about the app a path is inside. Answered by the
 *  server, because the path carries an id and nothing else. */
export interface InstalledAppNav {
    readonly name: string;
    /** The screen slugs this viewer may open, in the order the tab bar has them.
     *  Empty for an installed app that is not a game server - it has one screen,
     *  and a rail that replaced the app's own list with a list of one would be a
     *  worse place to stand than the list it replaced. */
    readonly tabs: readonly string[];
    /**
     * What this game calls a screen, where the shared name would be wrong.
     *
     * Only the ones that differ. A Minecraft mod and a FiveM resource are the
     * same screen and not the same word, and the rail calling it one thing while
     * the tab bar on the page calls it another is a disagreement about what a
     * screen is - which is the one thing a navigation must not be.
     */
    readonly labels?: Readonly<Record<string, string>>;
}

/**
 * A game server's rail.
 *
 * Not in APP_SUBAPPS for the same reason an organization is not: there is no
 * fixed list of them, and its base is only known once a path names it. Null when
 * this install has no screens of its own to show.
 */
export function installedAppSubapp(id: string, nav: InstalledAppNav): AppSubapp | null {
    const base = `${INSTALLED_BASE}/${id}`;
    const sections = nav.tabs.flatMap((slug) => {
        const entry = GAME_RAIL[slug];
        if (!entry) return [];
        const label = nav.labels?.[slug];
        return [{ ...entry, ...(label ? { label } : {}), href: slug ? `${base}/${slug}` : base }];
    });
    if (sections.length === 0) return null;
    return {
        id: `installed:${id}`,
        label: nav.name,
        icon: Gamepad2,
        base,
        parent: { label: "Game servers", href: "/apps/games" },
        sections
    };
}

/** The installed app id in a path, or null when the path is not inside one. */
export function installedAppIdForPath(pathname: string): string | null {
    if (!pathname.startsWith(`${INSTALLED_BASE}/`)) return null;
    const id = pathname.slice(INSTALLED_BASE.length + 1).split("/")[0] ?? "";
    return id ? decodeURIComponent(id) : null;
}

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
            {
                label: "Overview",
                href: base,
                icon: LayoutDashboard,
                keywords: ["organization", "summary"]
            },
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
    return (
        APP_SUBAPPS.find((sub) => pathname === sub.base || pathname.startsWith(`${sub.base}/`)) ??
        null
    );
}

/** Whether a path belongs to an app: its own subtree, or one of its extra
 *  `match` prefixes (exact segment or a nested path under it). */
function appOwnsPath(app: AppEntry, pathname: string): boolean {
    const owns = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
    return owns(app.href) || (app.match?.some(owns) ?? false);
}

/** The app the current path belongs to, defaulting to the first app (Overview),
 *  which is the one screen that belongs to no app in particular. */
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
export function isSectionActive(
    pathname: string,
    href: string,
    sections: readonly AppSection[]
): boolean {
    if (pathname === href) return true;
    if (sections.some((section) => section.href !== href && section.href.startsWith(`${href}/`)))
        return false;
    return pathname.startsWith(`${href}/`);
}
