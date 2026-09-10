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
    Bug,
    Building2,
    CalendarRange,
    Camera,
    Cctv,
    ChartColumn,
    CalendarClock,
    ChartPie,
    ClipboardCheck,
    Clock,
    Code2,
    Contact,
    Container,
    Database,
    EyeOff,
    FileText,
    Columns3,
    Presentation,
    Table2,
    FileStack,
    FolderGit2,
    FolderOpen,
    Gamepad2,
    Gauge,
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
    Mails,
    Flag,
    Mic,
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
    Share2,
    ShieldCheck,
    SlidersHorizontal,
    ToggleRight,
    Sparkles,
    SquareCheckBig,
    Star,
    Store,
    Tag,
    Target,
    Terminal,
    Timer,
    Trash2,
    UserCog,
    BadgeCheck,
    Users,
    UsersRound,
    Video,
    Wallet,
    Webhook,
    Workflow,
    Wrench,
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
     * What this app's badge is counting, in words, for the places that say it out
     * loud - a tooltip, a screen reader.
     *
     * Here rather than at each badge because the badge machinery deliberately
     * does not know which app it is drawing (see `app-unread`), and every one of
     * them said "unread messages". Which is right for Chat and Mail and wrong for
     * Management, where the number is reports and updates nobody has dealt with.
     */
    waiting?: { one: string; many: string };
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
    /** Extra path prefixes this app owns beyond `href`. Only for an app that
     *  lands on one of its own sections rather than on its root - Apps opens on
     *  Deploy and still owns the whole `/apps` subtree. A screen of an app
     *  belongs under that app's path and needs nothing here; see
     *  `test/navigation/app-paths.test.ts`. */
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
        description:
            "Your places, the cameras in them and the doors of them - what they saw, and what to do about it",
        icon: House,
        // Never "/home": that path belongs to Overview and spent a release
        // redirecting permanently to Drive, so browsers that followed it once
        // still do.
        href: "/places",
        permission: "home.read",
        requiresApp: "home"
    },
    {
        /**
         * The odd jobs, and the reason they are one app: somebody who has just
         * resized a picture is one click from optimizing it, and both are the
         * same upload as reading what is inside it. Split across a dozen entries
         * they would be a dozen things nobody remembers are here.
         *
         * Only present once somebody installs it, like Places - a Polaris that
         * converts nothing should not carry a menu entry for converting things.
         */
        id: "tools",
        label: "Tools",
        description:
            "Convert, resize, optimize, trim and translate - the small jobs, on your own machine",
        icon: Wrench,
        href: "/tools",
        permission: "tools.use",
        requiresApp: "tools"
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
        /**
         * Somebody's own mail, read here instead of in a browser tab that
         * belongs to somebody else.
         *
         * Its own app rather than a screen inside Chat, because they are not the
         * same thing: Chat is the people inside Polaris talking to each other,
         * and this is correspondence with everybody outside it, on servers
         * Polaris does not own. Sharing a surface would make one of them a
         * second-class version of the other.
         */
        id: "mail",
        label: "Mail",
        description: "Your mailboxes, read and answered here",
        icon: Mail,
        href: "/mail",
        permission: "mail.use"
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
        /**
         * Documents, spreadsheets, presentations and diagrams - the office
         * suite, in the browser and edited by several people at once.
         *
         * Its own app rather than a corner of Notes, and the two are not the
         * same thing however similar they sound. Notes is a notebook: Markdown,
         * nested, one person's, portable out of Polaris in the form it went in.
         * This is a word processor and the three things beside it - page layout,
         * formulas, slides, a canvas - opened and saved as the formats the rest
         * of the world sends. Google keeps Keep and Docs apart for the same
         * reason.
         */
        id: "office",
        label: "Office",
        description: "Documents, spreadsheets, slides and diagrams, written together",
        icon: FileStack,
        href: "/office",
        permission: "office.use"
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
        waiting: { one: "thing needs an administrator", many: "things need an administrator" },
        guest: {
            permission: "inbox.read",
            href: "/admin/inbox",
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
    /**
     * The instance permission this screen needs, where it is not the one the app
     * itself costs.
     *
     * Most sections need nothing: reaching Drive is what reaches its files, its
     * favourites and its bin. A few are a different subject that happens to live
     * in the same rail - Snippets under Drive, half of Apps - and those were
     * drawn for everybody and then turned people away on the click, which is the
     * worst of the three possible behaviours: it advertises something, wastes a
     * navigation, and says "not for you" in a place nobody can act on.
     *
     * A section that names one is left out of the rail entirely rather than
     * drawn greyed. A permanent row saying there is something here you cannot
     * have is noise on every render for the many accounts that will never have
     * it, and it is not how the app switcher behaves either - an app nobody can
     * open is simply not in it.
     */
    needs?: Permission;
    /** The same, for a screen only an administrator may open inside an app that
     *  is not itself admin-only - or inside one reached through its guest
     *  subject, where the whole rail would otherwise be offered. */
    adminOnly?: boolean;
    /** Shown as well to somebody who may end the organization without running it -
     *  the successor its owner named. Deleting is deliberately not a permission,
     *  so it cannot be expressed as one above. */
    orgDeleter?: boolean;
    /**
     * The marketplace app whose install puts this screen here, for a screen that
     * is a feature somebody opts into inside an app everybody has - the section
     * counterpart of `AppEntry.requiresApp`.
     *
     * Not a permission and not answered like one: nobody is being refused, there
     * is nothing there yet. So it is asked of administrators too, and resolved on
     * the server (see `installedSectionApps`) because the answer is a query.
     */
    requiresApp?: string;
}

/**
 * What narrows a rail and the search for one viewer, resolved on the server and
 * handed to the client components that draw them.
 */
export interface SectionGate {
    readonly isAdmin: boolean;
    /** The instance permissions held, of the ones any section names. */
    readonly held: readonly string[];
    /** The marketplace apps installed, of the ones any section requires. */
    readonly installed: readonly string[];
}

/**
 * Whether a section is offered to this viewer at all.
 *
 * One answer for the rail, the phone drawer and the search, so the three never
 * disagree about what exists. An app that is not installed is asked first and
 * of everybody: an administrator passes every permission, and still has no
 * screen for something this Polaris does not have.
 */
export function sectionOffered(section: AppSection, gate: SectionGate): boolean {
    if (section.requiresApp && !gate.installed.includes(section.requiresApp)) return false;
    if (section.adminOnly && !gate.isAdmin) return false;
    return !section.needs || gate.isAdmin || gate.held.includes(section.needs);
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
const DEVICES_GROUP = "Devices";

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
        {
            label: "Shared",
            href: "/drive/shared",
            icon: Share2,
            keywords: ["shared with me", "people", "sent me", "gave me", "access"]
        },
        { label: "Favorites", href: "/drive/favorites", icon: Star, keywords: ["starred"] },
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
            needs: "snippets.read",
            icon: Code2,
            keywords: ["paste", "pastebin", "code", "text", "env", "secret", "gist", "share text"]
        },
        {
            label: "Drop points",
            href: "/drive/drop-points",
            icon: Inbox,
            keywords: ["file requests", "uploads", "ask for text", "collect"]
        },
        {
            label: "Where the room went",
            href: "/drive/insights",
            icon: ChartPie,
            keywords: [
                "storage",
                "disk",
                "space",
                "usage",
                "biggest",
                "largest files",
                "heaviest folders",
                "formats",
                "full",
                "analyse",
                "analyzer"
            ]
        },
        { label: "Trash", href: "/drive/trash", icon: Trash2, keywords: ["deleted", "bin"] }
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
            needs: "games.read",
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
            needs: "system.manage",
            icon: Server,
            group: MACHINES_GROUP,
            keywords: ["hosts", "machines", "ssh"]
        },
        {
            label: "Runners",
            href: "/apps/runners",
            needs: "system.manage",
            icon: Workflow,
            group: MACHINES_GROUP,
            keywords: ["github actions", "ci"]
        },
        {
            label: "Agents",
            href: "/apps/agents",
            needs: "agents.read",
            icon: Bot,
            keywords: ["coding agent", "ai", "review", "pull requests", "issues", "github"]
        },
        {
            label: "Code",
            href: "/apps/code",
            needs: "agents.read",
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
            needs: "deploy.manage",
            icon: ShieldCheck,
            group: OPERATIONS_GROUP,
            keywords: ["waf", "ip", "allowlist", "denylist", "block", "access"]
        },
        {
            label: "Analytics",
            href: "/apps/analytics",
            needs: "deploy.manage",
            icon: ChartColumn,
            group: OPERATIONS_GROUP,
            keywords: ["visitors", "traffic", "pageviews", "referrers", "metrics", "umami"]
        },
        {
            label: "Telemetry",
            href: "/apps/telemetry",
            needs: "deploy.manage",
            icon: Bug,
            group: OPERATIONS_GROUP,
            keywords: [
                "errors",
                "exceptions",
                "crashes",
                "stack trace",
                "sentry",
                "issues",
                "logging"
            ]
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
            adminOnly: true,
            icon: Archive,
            group: OPERATIONS_GROUP,
            keywords: ["restore", "snapshots"]
        },
        {
            // Here rather than under Management: a mail server is a service the
            // operator runs on their machines, deployed through Deploy and backed
            // up by Backups, beside which it sits. Management configures Polaris
            // itself; reading mail stays in Mail. Only here once somebody installs
            // it from the marketplace: a Polaris that runs no mail server should
            // not carry a door onto one.
            label: "Mail server",
            href: "/apps/mail-server",
            needs: "mailserver.manage",
            requiresApp: "mail-server",
            icon: Mails,
            group: OPERATIONS_GROUP,
            keywords: [
                "smtp",
                "imap",
                "email server",
                "mailboxes",
                "domains",
                "dkim",
                "spf",
                "dmarc",
                "mx",
                "relay",
                "smarthost",
                "aliases",
                "forwards",
                "catch-all"
            ]
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
            label: "Devices",
            group: DEVICES_GROUP,
            href: "/places/devices",
            icon: ToggleRight,
            keywords: [
                "locks",
                "lock",
                "unlock",
                "nuki",
                "smart lock",
                "door",
                "open the door",
                "who opened",
                "access",
                "switch",
                "socket",
                "plug",
                "light",
                "tuya",
                "smart home"
            ]
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
        },
        {
            label: "Connected trackers",
            href: "/tasks/trackers",
            needs: "tasks.manage",
            icon: Link2,
            keywords: ["linear", "jira", "import", "sync", "issues", "two-way"]
        }
    ],
    /**
     * Mail draws no rail from here.
     *
     * What belongs in it is one account's folders as that server names them,
     * which is a list only the server knows and which differs per mailbox - so
     * the app renders its own, exactly as Chat does. Every entry below is hidden
     * and exists so the global search can find a screen by name: somebody
     * looking for "filters" or "away message" types that, not "mail".
     */
    mail: [
        {
            label: "Inbox",
            href: "/mail",
            icon: Inbox,
            hidden: true,
            keywords: ["email", "gmail", "imap", "unread", "messages", "correo"]
        },
        {
            label: "Starred",
            href: "/mail/starred",
            icon: Star,
            hidden: true,
            keywords: ["flagged", "important"]
        },
        {
            label: "Sent",
            href: "/mail/sent",
            icon: SendHorizontal,
            hidden: true,
            keywords: ["outbox", "what I sent"]
        },
        {
            label: "Drafts",
            href: "/mail/drafts",
            icon: FileText,
            hidden: true,
            keywords: ["unsent", "scheduled", "send later", "unfinished"]
        },
        {
            label: "Archive",
            href: "/mail/archive",
            icon: Archive,
            hidden: true,
            keywords: ["archived", "put away"]
        },
        {
            label: "Spam",
            href: "/mail/junk",
            icon: Bug,
            hidden: true,
            keywords: ["junk", "phishing", "unwanted"]
        },
        {
            label: "Trash",
            href: "/mail/trash",
            icon: Trash2,
            hidden: true,
            keywords: ["deleted", "bin"]
        },
        {
            label: "Mailboxes",
            href: "/mail/settings/accounts",
            icon: Mail,
            hidden: true,
            keywords: [
                "add mailbox",
                "connect email",
                "link gmail",
                "outlook",
                "imap",
                "smtp",
                "app password",
                "server settings"
            ]
        },
        {
            label: "Send-as addresses",
            href: "/mail/settings/identities",
            icon: IdCard,
            hidden: true,
            keywords: ["alias", "identity", "from address", "send as"]
        },
        {
            label: "Labels",
            href: "/mail/settings/labels",
            icon: Tag,
            hidden: true,
            keywords: ["tag", "colour", "group mail", "categories"]
        },
        {
            label: "Filters",
            href: "/mail/settings/rules",
            icon: Workflow,
            hidden: true,
            keywords: ["rules", "sieve", "sort mail", "file automatically", "block sender"]
        },
        {
            label: "Signature",
            href: "/mail/settings/signature",
            icon: NotebookPen,
            hidden: true,
            keywords: ["sign off", "footer"]
        },
        {
            label: "Privacy",
            href: "/mail/settings/privacy",
            icon: EyeOff,
            hidden: true,
            keywords: [
                "trackers",
                "tracking pixel",
                "remote images",
                "block images",
                "read receipt",
                "clean links"
            ]
        },
        {
            label: "Away message",
            href: "/mail/settings/away",
            icon: CalendarClock,
            hidden: true,
            keywords: ["out of office", "vacation", "holiday", "auto reply", "autoresponder"]
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
            keywords: [
                "name",
                "display name",
                "username",
                "handle",
                "avatar",
                "photo",
                "banner",
                "bio",
                "appearance",
                "decoration",
                "nameplate",
                "company"
            ]
        },
        // Everything the profile publishes nothing of: the name held on the
        // account, the addresses that sign it in, the number a code goes to.
        // Split out of the profile because the consequence of a field is the
        // difference between the two screens - what a colleague sees, against
        // how Polaris reaches you - and one form could not say which was which.
        {
            label: "Account",
            href: "/account/details",
            icon: IdCard,
            keywords: [
                "email",
                "email address",
                "addresses",
                "phone",
                "number",
                "sign in",
                "first name",
                "last name",
                "legal name"
            ]
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
            keywords: [
                "units",
                "language",
                "timezone",
                "week start",
                "calendar",
                "text size",
                "accessibility"
            ]
        },
        // The microphone, the camera and everything around them. Its own screen
        // rather than a card under Preferences: what is answered here is a fact
        // about the machine in front of somebody, and it is the screen people
        // are sent to when a call goes wrong.
        //
        // Not called "Devices": everywhere else in Polaris that word means the
        // browsers and phones an account is signed in on, and somebody hunting
        // for their microphone had no reason to guess this one meant something
        // else. "Devices" stays in the keywords, so looking for it still lands
        // here.
        {
            label: "Voice & Video",
            href: "/account/devices",
            icon: Mic,
            keywords: [
                "devices",
                "speakers",
                "headset",
                "microphone",
                "camera",
                "webcam",
                "audio",
                "video",
                "noise",
                "push to talk",
                "voice activity",
                "gain",
                "attenuation",
                "test"
            ]
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
    office: [
        {
            label: "Recent",
            href: "/office",
            icon: Clock,
            keywords: ["all", "documents", "files", "everything"]
        },
        { label: "Starred", href: "/office/starred", icon: Star, keywords: ["favourites"] },
        {
            label: "Shared with me",
            href: "/office/shared",
            icon: Users,
            keywords: ["gave me", "sent me", "access"]
        },
        {
            label: "Documents",
            href: "/office/kind/doc",
            icon: FileText,
            group: "Kinds",
            keywords: ["docs", "word", "docx", "writing"]
        },
        {
            label: "Spreadsheets",
            href: "/office/kind/sheet",
            icon: Table2,
            group: "Kinds",
            keywords: ["sheets", "excel", "xlsx", "formulas", "numbers"]
        },
        {
            label: "Presentations",
            href: "/office/kind/slides",
            icon: Presentation,
            group: "Kinds",
            keywords: ["slides", "powerpoint", "pptx", "deck"]
        },
        {
            label: "Diagrams",
            href: "/office/kind/diagram",
            icon: Workflow,
            group: "Kinds",
            keywords: ["draw", "whiteboard", "flowchart", "architecture"]
        },
        {
            label: "Comparisons",
            href: "/office/kind/comparison",
            icon: Columns3,
            group: "Kinds",
            keywords: ["competitors", "battlecard", "matrix", "vendors", "alternatives"]
        },
        {
            label: "Archive",
            href: "/office/archive",
            icon: Archive,
            group: "Filed",
            keywords: ["archived", "put away"]
        },
        {
            label: "Trash",
            href: "/office/trash",
            icon: Trash2,
            group: "Filed",
            keywords: ["bin", "deleted", "removed"]
        }
    ],
    admin: [
        { label: "Overview", href: "/admin", adminOnly: true, icon: LayoutDashboard },
        {
            label: "Activity",
            href: "/admin/activity",
            adminOnly: true,
            icon: Activity,
            keywords: ["audit", "logs"]
        },
        {
            label: "Evidence",
            href: "/admin/evidence",
            adminOnly: true,
            icon: ClipboardCheck,
            keywords: [
                "compliance",
                "soc 2",
                "iso 27001",
                "auditor",
                "controls",
                "report",
                "export",
                "certification"
            ]
        },
        {
            label: "Users",
            href: "/admin/users",
            adminOnly: true,
            icon: Users,
            keywords: ["accounts", "invites"],
            group: ADMIN_PEOPLE_GROUP
        },
        {
            label: "Groups",
            href: "/admin/groups",
            adminOnly: true,
            icon: UsersRound,
            keywords: ["teams"],
            group: ADMIN_PEOPLE_GROUP
        },
        {
            label: "Organizations",
            href: "/admin/organizations",
            adminOnly: true,
            icon: Building2,
            keywords: ["org", "orgs", "teams", "company", "limits", "turn off"],
            group: ADMIN_PEOPLE_GROUP
        },
        {
            label: "Roles",
            href: "/admin/roles",
            adminOnly: true,
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
            adminOnly: true,
            icon: Scale,
            keywords: ["permissions", "access"],
            group: ADMIN_ACCESS_GROUP
        },
        {
            label: "Security",
            href: "/admin/security",
            adminOnly: true,
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
            href: "/admin/inbox",
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
            adminOnly: true,
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
            adminOnly: true,
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
            label: "Safety",
            href: "/admin/safety",
            adminOnly: true,
            icon: Flag,
            keywords: [
                "reports",
                "moderation",
                "abuse",
                "spam",
                "flagged",
                "chat",
                "lockdown",
                "locked down",
                "quarantine",
                "reported user",
                "reported account"
            ],
            group: ADMIN_COMMUNICATION_GROUP
        },
        {
            label: "Consumption",
            href: "/admin/consumption",
            adminOnly: true,
            icon: Gauge,
            keywords: [
                "usage",
                "resources",
                "memory",
                "ram",
                "cpu",
                "disk",
                "footprint",
                "what is using",
                "containers",
                "apps",
                "marketplace"
            ],
            group: ADMIN_PLATFORM_GROUP
        },
        {
            label: "Billing",
            href: "/admin/billing",
            adminOnly: true,
            icon: Wallet,
            keywords: [
                "cost",
                "costs",
                "prices",
                "rates",
                "charge back",
                "chargeback",
                "invoice",
                "statement",
                "budget",
                "spend",
                "usage",
                "vcpu",
                "per project"
            ],
            group: ADMIN_PLATFORM_GROUP
        },
        {
            label: "Domains",
            href: "/admin/domains",
            adminOnly: true,
            icon: Globe,
            keywords: ["dns", "tunnels", "certificates"],
            group: ADMIN_PLATFORM_GROUP
        },
        {
            label: "Display defaults",
            href: "/admin/display",
            adminOnly: true,
            icon: SlidersHorizontal,
            keywords: ["units", "formats"],
            group: ADMIN_PLATFORM_GROUP
        },
        {
            label: "Agent defaults",
            href: "/admin/agents",
            adminOnly: true,
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
            label: "Keeping records",
            href: "/admin/retention",
            adminOnly: true,
            icon: Trash2,
            keywords: [
                "retention",
                "logs",
                "notifications",
                "activity",
                "audit",
                "history",
                "delete old",
                "purge",
                "prune",
                "how long",
                "days",
                "gdpr",
                "cleanup",
                "disk"
            ],
            group: ADMIN_PLATFORM_GROUP
        },
        {
            label: "Uploads",
            href: "/admin/uploads",
            adminOnly: true,
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
            href: "/admin/integrations",
            adminOnly: true,
            icon: Blocks,
            keywords: ["github", "cloudflare", "connect"],
            group: ADMIN_PLATFORM_GROUP
        },
        {
            label: "AI providers",
            href: "/admin/integrations/models",
            adminOnly: true,
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
            href: "/admin/settings",
            adminOnly: true,
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
        base: "/admin/inbox",
        parent: { label: "Management", href: "/admin" },
        parentAppId: "admin",
        sections: [
            {
                label: "Conversations",
                href: "/admin/inbox",
                icon: MessagesSquare,
                keywords: ["chats", "messages"]
            },
            {
                label: "Contacts",
                href: "/admin/inbox/contacts",
                icon: Contact,
                keywords: ["people"]
            },
            {
                label: "Channels",
                href: "/admin/inbox/channels",
                icon: Radio,
                keywords: ["whatsapp", "telegram", "slack", "discord"]
            },
            { label: "Logs", href: "/admin/inbox/logs", icon: ScrollText }
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
                needs: "agents.read",
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
                needs: "agents.read",
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
                label: "Sessions",
                href: "/apps/agents/sessions",
                needs: "agents.read",
                icon: MessagesSquare,
                keywords: [
                    "live",
                    "claude code",
                    "codex",
                    "terminal",
                    "worktree",
                    "steer",
                    "interactive",
                    "talk to"
                ]
            },
            {
                label: "Runs",
                href: "/apps/agents/runs",
                needs: "agents.read",
                icon: History,
                keywords: ["history", "logs", "failed", "what happened"]
            },
            {
                label: "Settings",
                href: "/apps/agents/settings",
                needs: "agents.read",
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
                needs: "agents.read",
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
                needs: "system.manage",
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
                needs: "system.manage",
                icon: History,
                keywords: ["history", "jobs", "workflow runs", "builds", "logs", "failed"]
            },
            {
                label: "Secrets",
                href: "/apps/runners/secrets",
                needs: "system.manage",
                icon: KeyRound,
                keywords: ["variables", "env", "credentials", "tokens", "passwords"]
            },
            {
                label: "How it works",
                href: "/apps/runners/guide",
                needs: "system.manage",
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
                label: "Mailboxes",
                href: `${base}/mailboxes`,
                icon: Mail,
                permission: "mail.manage",
                keywords: ["email", "addresses", "company address", "support", "hand out"]
            },
            {
                label: "Domains",
                href: `${base}/domains`,
                icon: Globe,
                permission: "domains.manage",
                keywords: ["dns", "deploys", "hostnames", "custom domain", "wildcard"]
            },
            {
                label: "Billing",
                href: `${base}/billing`,
                icon: Wallet,
                permission: "settings.manage",
                keywords: ["cost", "costs", "budget", "spend", "statement", "invoice", "usage", "charge back"]
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
