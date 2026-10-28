/**
 * The Polaris app registry - what appears in the top-left switcher. Deliberately
 * small so the dashboard stays legible as it grows: Drive, the umbrella Apps
 * pillar (marketplace + everything Polaris installs and runs), and Management.
 * What is installed from the marketplace lives under Apps, except the few apps
 * that are a whole product of their own - Places, Tools, Game servers - which
 * join the switcher once somebody installs them (`requiresApp`).
 */

import type { GrantSubject, OrgPermission, Permission } from "@polaris/core";
import {
    BatteryCharging,
    Activity,
    Archive,
    Bell,
    Bot,
    BotMessageSquare,
    Blocks,
    BookOpen,
    Bug,
    Building2,
    CalendarDays,
    CalendarRange,
    Cctv,
    ChartColumn,
    CalendarClock,
    ChartLine,
    ChartPie,
    ClipboardCheck,
    Clock,
    Code2,
    Contact,
    Container,
    Database,
    Download,
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
    Joystick,
    Handshake,
    Cloud,
    GitCompareArrows,
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
    MessageSquareWarning,
    Crown,
    MessagesSquare,
    MonitorSmartphone,
    Network,
    NotebookPen,
    PartyPopper,
    Radio,
    Rocket,
    ScanFace,
    ScanLine,
    ScanSearch,
    Scale,
    ScrollText,
    SendHorizontal,
    Server,
    Settings,
    Share2,
    ShieldBan,
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
    Trophy,
    UserCog,
    BadgeCheck,
    Users,
    UsersRound,
    Video,
    Wallet,
    Webhook,
    Wifi,
    Workflow,
    Wrench,
    Megaphone,
    PanelRight,
    Keyboard,
    Music,
    TrendingUp,
    Stethoscope,
    Waypoints,
    EthernetPort,
    FileBadge,
    type LucideIcon
} from "lucide-react";
import { GAME_SERVERS_APP_ID } from "@/lib/apps/games-catalog";

/**
 * What each app is for. The app menu draws one grid with no headings, so these
 * are never drawn there; the menu's search finds an app by its category, in
 * English and in the reader's language ("games" finds Game servers). Named in
 * English like every other label here (`nav.labels` translates them).
 */
export const APP_CATEGORIES = [
    { id: "work", label: "Work" }, // i18n-ignore
    { id: "communication", label: "Communication" }, // i18n-ignore
    { id: "home", label: "Home" }, // i18n-ignore
    { id: "infrastructure", label: "Infrastructure" }, // i18n-ignore
    { id: "games", label: "Games" }, // i18n-ignore
    { id: "tools", label: "Tools" } // i18n-ignore
] as const;

export type AppCategory = (typeof APP_CATEGORIES)[number]["id"];

export interface AppEntry {
    id: string;
    label: string;
    description: string;
    icon: LucideIcon;
    href: string;
    /** What the app is for, which the app menu's search finds it by. Required,
     *  so an app added without one fails to compile. */
    category: AppCategory;
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
     *
     * Inbox only exists once the messaging bridge is installed, so the door names
     * that app in `requiresApp` and the subject to open instead without it in
     * `otherwise` - for Management, the member's own email and SMS senders.
     */
    guest?: {
        permission: Permission;
        href: string;
        label: string;
        description: string;
        requiresApp?: string;
        otherwise?: { href: string; label: string; description: string };
    };
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
    /** Whether the app keeps favorites of its own, listed under its rail
     *  (see the `favorites` extension hook). */
    favorites?: boolean;
    /** Extra path prefixes this app owns beyond `href`. Only for an app that
     *  lands on one of its own sections rather than on its root - Apps opens on
     *  Deploy and still owns the whole `/apps` subtree. A screen of an app
     *  belongs under that app's path and needs nothing here; see
     *  `test/navigation/app-paths.test.ts`. */
    match?: string[];
}

/** The landing screen's own app id. It is the one app whose rail is the others. */
export const OVERVIEW_APP_ID = "overview";

// i18n-ignore (marked per line below): labels, descriptions and keywords are data read by search and the rail; screens translate them where drawn (nav.labels, nav.apps).
export const POLARIS_APPS: AppEntry[] = [
    {
        id: OVERVIEW_APP_ID,
        category: "work",
        label: "Overview", // i18n-ignore
        description: "Your services, usage and shortcuts at a glance", // i18n-ignore
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
        category: "work",
        label: "Drive", // i18n-ignore
        description: "Files across every NAS", // i18n-ignore
        icon: HardDrive,
        href: "/drive",
        permission: "drive.read"
    },
    {
        id: "vault",
        category: "tools",
        label: "Vault", // i18n-ignore
        description: "Passwords, keys and secrets, encrypted in your browser", // i18n-ignore
        icon: KeyRound,
        href: "/vault",
        permission: "vault.use"
    },
    {
        id: "apps",
        category: "infrastructure",
        label: "Apps", // i18n-ignore
        description: "Install & run apps: deploys, servers, assistants", // i18n-ignore
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
        category: "home",
        label: "Places", // i18n-ignore
        description:
            "Your places, the cameras in them and the doors of them - what they saw, and what to do about it", // i18n-ignore
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
        category: "tools",
        label: "Tools", // i18n-ignore
        description:
            "Convert, resize, optimize, trim and translate - the small jobs, on your own machine", // i18n-ignore
        icon: Wrench,
        href: "/tools",
        permission: "tools.use",
        requiresApp: "tools"
    },
    {
        /**
         * Minecraft, ARK and FiveM servers on your own machines.
         *
         * An app of its own, beside Places and Tools, rather than a screen in
         * Apps: somebody who runs a server for their friends is not deploying
         * anything, and it only exists once somebody installs it. Its path stays
         * under /apps because every server's own screens already live there, with
         * the installed apps, and links to them are in people's bookmarks.
         */
        id: "games",
        category: "games",
        label: "Game servers", // i18n-ignore
        description: "Minecraft, ARK and FiveM servers on your own machines", // i18n-ignore
        icon: Gamepad2,
        href: "/apps/games",
        permission: "games.read",
        requiresApp: GAME_SERVERS_APP_ID
    },
    {
        /**
         * Games people play in the browser, on their own or together from a
         * call. Not Game servers: nothing runs anywhere but the reader's tab.
         *
         * Installable: a Polaris where nobody plays carries no entry for it.
         */
        id: "arcade",
        category: "games",
        label: "Games", // i18n-ignore
        description: "Play on your own, or together from a call", // i18n-ignore
        icon: Joystick,
        href: "/games",
        permission: "arcade.open",
        requiresApp: "arcade"
    },
    {
        id: "tasks",
        category: "work",
        label: "Tasks", // i18n-ignore
        description: "Plan and track work: spaces, lists, boards & goals", // i18n-ignore
        icon: SquareCheckBig,
        href: "/tasks",
        permission: "tasks.read"
    },
    {
        id: "chat",
        category: "communication",
        label: "Chat", // i18n-ignore
        description: "Channels, direct messages and calls with the people here", // i18n-ignore
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
        category: "communication",
        label: "Mail", // i18n-ignore
        description: "Your mailboxes, read and answered here", // i18n-ignore
        icon: Mail,
        href: "/mail",
        permission: "mail.use"
    },
    {
        /**
         * Somebody's own calendars and the ones they link from outside.
         *
         * Installable, like Places and Tools: a Polaris nobody schedules
         * anything in carries no menu entry for it.
         */
        id: "calendar",
        category: "work",
        label: "Calendar", // i18n-ignore
        description: "Your calendars and the ones you link, in one place", // i18n-ignore
        icon: CalendarDays,
        href: "/calendar",
        permission: "calendar.use",
        requiresApp: "calendar"
    },
    {
        /**
         * Companies, people and the opportunities worked with them - for one
         * person, or shared by an organization under its own roles.
         *
         * Installable: a Polaris that sells nothing carries no menu entry for it.
         */
        id: "crm",
        category: "work",
        label: "CRM", // i18n-ignore
        description: "Companies, people and the deals you are working", // i18n-ignore
        icon: Handshake,
        href: "/crm",
        permission: "crm.use",
        requiresApp: "crm",
        favorites: true
    },
    {
        /**
         * Public pages that say whether services are up, from checks Polaris
         * runs, with the incidents and maintenance the operator posts.
         *
         * Installable: a Polaris that publishes no status carries no entry for it.
         */
        id: "status-pages",
        category: "work",
        label: "Status pages", // i18n-ignore
        description: "Public pages that show whether your services are up", // i18n-ignore
        icon: Activity,
        href: "/status-pages",
        permission: "status.manage",
        requiresApp: "status-pages"
    },
    {
        id: "notes",
        category: "work",
        label: "Notes", // i18n-ignore
        description: "Write things down, nested the way a notebook is", // i18n-ignore
        icon: NotebookPen,
        href: "/notes",
        permission: "notes.use"
    },
    {
        /**
         * Polar, the assistant. It lives in a panel on every page (the header
         * button, Ctrl/Cmd+J); this is the same chat as a page, with the
         * conversation list beside it. No permission of its own: it acts with
         * exactly what the person can already do, and asks before any change.
         */
        id: "polar",
        category: "work",
        label: "Polar", // i18n-ignore
        description: "Ask about any page, and have things done with your access", // i18n-ignore
        icon: BotMessageSquare,
        href: "/polar"
    },
    {
        /**
         * When something happens, do something: one engine every app plugs its
         * triggers and actions into. Core, not installable - the engine is what
         * the apps' own automation screens become windows onto.
         */
        id: "automations",
        category: "work",
        label: "Automations", // i18n-ignore
        description: "When something happens, do something, across your apps", // i18n-ignore
        icon: Workflow,
        href: "/automations",
        permission: "automations.use"
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
        category: "work",
        label: "Office", // i18n-ignore
        description: "Documents, spreadsheets, slides and diagrams, written together", // i18n-ignore
        icon: FileStack,
        href: "/office",
        permission: "office.use"
    },
    {
        id: "watch",
        category: "infrastructure",
        label: "Watch", // i18n-ignore
        description: "Alarms on app health, spikes and outages", // i18n-ignore
        icon: Activity,
        href: "/watch",
        permission: "deploy.read"
    },
    {
        id: "admin",
        category: "infrastructure",
        label: "Management", // i18n-ignore
        description: "Users, access, domains & updates", // i18n-ignore
        icon: SlidersHorizontal,
        href: "/admin",
        adminOnly: true,
        guest: {
            permission: "inbox.read",
            href: "/admin/inbox",
            label: "Inbox", // i18n-ignore
            description: "Customer conversations across every channel", // i18n-ignore
            requiresApp: "messaging-bridge",
            otherwise: {
                href: "/admin/email",
                label: "Email & SMS", // i18n-ignore
                description: "The senders your mail and texts go out through" // i18n-ignore
            }
        }
    },
    {
        id: "account",
        category: "tools",
        label: "My account", // i18n-ignore
        description: "Profile, security & API keys", // i18n-ignore
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
    /**
     * A grant subject that opens this screen to somebody who holds a live grant
     * over it, past `adminOnly` and `needs` - Watch's connectivity record, shared
     * by an administrator with somebody who runs nothing else here. Resolved on
     * the server into `SectionGate.held`, beside the permissions.
     */
    reachedBy?: GrantSubject;
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
    /** The instance permissions held, of the ones any section names, and the
     *  grant subjects (`reachedBy`) this viewer holds a live grant over. */
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
    if (section.reachedBy && gate.held.includes(section.reachedBy)) return true;
    if (section.adminOnly && !gate.isAdmin) return false;
    return !section.needs || gate.isAdmin || gate.held.includes(section.needs);
}

/**
 * The sections of each app, keyed by app id. Drives the left rail and the global
 * search index, so a page added here becomes navigable and findable at once.
 * Apps with no entry render no rail.
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

/**
 * The headings the Apps rail is read under.
 *
 * Twenty entries under three headings left nine under Machines and seven under
 * Operations - each a list to read through, not a place the eye lands. Grouped
 * the way infrastructure consoles split theirs: what you build with, the machines,
 * the network in front of them, the data and services on them, and how they are
 * watched. Deploy and the Marketplace stay ungrouped at the top, because they are
 * where most visits start. No heading holds more than seven entries
 * (`test/navigation/rail-group-sizes.test.ts`).
 */
const DEVELOPMENT_GROUP = "Development";
const MACHINES_GROUP = "Machines";
const NETWORK_GROUP = "Network";
const DATA_GROUP = "Data & services";
const OBSERVABILITY_GROUP = "Observability";

/** What people call the Network filter when they search for it: the rail and the
 *  store both find it by these. */
export const DNS_BLOCKER_KEYWORDS: readonly string[] = [
    "dns",
    "dns filter",
    "ad blocker",
    "adblock",
    "pi-hole",
    "adguard",
    "blocklist",
    "trackers",
    "malware",
    "port 53"
];

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

/** The heading for what somebody building on Polaris needs: API keys, their own
 *  model keys and the domains their deploys answer on. */
const DEVELOPERS_GROUP = "Developers";

/** The heading the Management areas are listed under, below the screens that
 *  answer before you know which area your question is in. */
const ADMIN_AREAS_GROUP = "Areas";

/**
 * Platform's Domains heading. Domains grew past one page - the tunnels, the ports
 * and the certificates each answer a different question, and on one page they
 * were a long scroll - so its screens sit under a heading of their own in the
 * Platform rail, at the addresses below /admin/domains.
 */
const DOMAINS_GROUP = "Domains";

/**
 * The Management areas, each a rail of its own.
 *
 * Twenty-odd screens under seven headings was still a list to read through, so
 * the Management rail now holds only Overview, Activity, Evidence and one entry
 * per area - the way Agents sits inside Apps. Opening an area swaps the rail to
 * its screens with a way back, and the screens keep the addresses they had,
 * which is why most areas claim theirs through `match` rather than `base`.
 */
const ADMIN_AREAS: AppSubapp[] = [
    {
        id: "admin-people",
        label: "People & access", // i18n-ignore
        icon: Users,
        base: "/admin/users",
        match: [
            "/admin/groups",
            "/admin/announcements",
            "/admin/organizations",
            "/admin/roles",
            "/admin/policies",
            "/admin/security",
            "/admin/sso"
        ],
        parent: { label: "Management", href: "/admin" }, // i18n-ignore
        parentAppId: "admin",
        sections: [
            {
                label: "Users", // i18n-ignore
                href: "/admin/users",
                adminOnly: true,
                icon: Users,
                keywords: ["accounts", "invites"]
            },
            {
                label: "Announcements", // i18n-ignore
                href: "/admin/announcements",
                adminOnly: true,
                icon: Megaphone,
                keywords: [
                    "maintenance",
                    "banner",
                    "broadcast",
                    "notify everyone",
                    "outage",
                    "notice"
                ]
            },
            {
                label: "Groups", // i18n-ignore
                href: "/admin/groups",
                adminOnly: true,
                icon: UsersRound,
                keywords: ["teams"]
            },
            {
                label: "Organizations", // i18n-ignore
                href: "/admin/organizations",
                adminOnly: true,
                icon: Building2,
                keywords: ["org", "orgs", "teams", "company", "limits", "turn off"]
            },
            {
                label: "Roles", // i18n-ignore
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
                ]
            },
            {
                label: "Policies", // i18n-ignore
                href: "/admin/policies",
                adminOnly: true,
                icon: Scale,
                keywords: ["permissions", "access"]
            },
            {
                label: "Security", // i18n-ignore
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
                ]
            },
            {
                label: "Security scans", // i18n-ignore
                href: "/admin/security/scans",
                adminOnly: true,
                icon: ScanSearch,
                keywords: [
                    "vulnerabilities",
                    "cve",
                    "image scans",
                    "polaris images",
                    "own images",
                    "containers"
                ]
            },
            {
                label: "Single sign-on", // i18n-ignore
                href: "/admin/sso",
                adminOnly: true,
                icon: ShieldCheck,
                keywords: ["sso", "saml", "identity provider", "idp", "okta", "entra", "domain"]
            }
        ]
    },
    {
        id: "admin-communication",
        label: "Communication", // i18n-ignore
        icon: MessageSquare,
        base: "/admin/email",
        match: ["/admin/chat", "/admin/safety"],
        parent: { label: "Management", href: "/admin" }, // i18n-ignore
        parentAppId: "admin",
        sections: [
            {
                // Senders belong to whoever added them, so anybody who can open the
                // Inbox can add their own; only the account-mail choice is an admin's.
                label: "Email & SMS", // i18n-ignore
                href: "/admin/email",
                needs: "inbox.read",
                icon: Mail,
                keywords: [
                    "smtp",
                    "sender",
                    "sms",
                    "texts",
                    "twilio",
                    "resend",
                    "brevo",
                    "mailjet",
                    "ses",
                    "outgoing",
                    "account mail"
                ]
            },
            {
                label: "Chat", // i18n-ignore
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
                ]
            },
            {
                label: "Safety", // i18n-ignore
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
                ]
            }
        ]
    },
    {
        id: "admin-platform",
        label: "Platform", // i18n-ignore
        icon: Settings,
        base: "/admin/settings",
        match: ["/admin/apps", "/admin/setup", "/admin/display", "/admin/domains"],
        parent: { label: "Management", href: "/admin" }, // i18n-ignore
        parentAppId: "admin",
        sections: [
            {
                label: "Updates & settings", // i18n-ignore
                href: "/admin/settings",
                adminOnly: true,
                icon: Settings,
                keywords: ["version", "upgrade"]
            },
            {
                label: "Polaris apps", // i18n-ignore
                href: "/admin/apps",
                adminOnly: true,
                icon: Store,
                keywords: ["marketplace", "install", "catalog", "built in"]
            },
            {
                label: "Get started", // i18n-ignore
                href: "/admin/setup",
                adminOnly: true,
                icon: Rocket,
                keywords: ["setup", "first run", "wizard", "install apps", "onboarding"]
            },
            {
                label: "Display defaults", // i18n-ignore
                href: "/admin/display",
                adminOnly: true,
                icon: SlidersHorizontal,
                keywords: ["units", "formats"]
            },
            {
                label: "Domains", // i18n-ignore
                href: "/admin/domains",
                adminOnly: true,
                group: DOMAINS_GROUP,
                icon: Globe,
                keywords: ["dns", "dns records", "setup", "app domain", "sharing domain", "duckdns"]
            },
            {
                label: "Remote access", // i18n-ignore
                href: "/admin/domains/remote-access",
                adminOnly: true,
                group: DOMAINS_GROUP,
                icon: Waypoints,
                keywords: [
                    "tunnels",
                    "cloudflare tunnel",
                    "tailscale",
                    "relay",
                    "cgnat",
                    "backup access"
                ]
            },
            {
                label: "Ports", // i18n-ignore
                href: "/admin/domains/ports",
                adminOnly: true,
                group: DOMAINS_GROUP,
                icon: EthernetPort,
                keywords: ["port forwarding", "router", "game ports", "call ports", "nat"]
            },
            {
                label: "Certificates", // i18n-ignore
                href: "/admin/domains/certificates",
                adminOnly: true,
                group: DOMAINS_GROUP,
                icon: FileBadge,
                keywords: ["https", "tls", "ssl", "root certificate", "polaris.local", "acme"]
            },
            {
                label: "Domain security", // i18n-ignore
                href: "/admin/domains/security",
                adminOnly: true,
                group: DOMAINS_GROUP,
                icon: ShieldCheck,
                keywords: ["spoofing", "dmarc", "spf", "dkim", "registration", "expiry"]
            }
        ]
    },
    {
        id: "admin-integrations",
        label: "Integrations & AI", // i18n-ignore
        icon: Blocks,
        base: "/admin/integrations",
        match: ["/admin/agents"],
        parent: { label: "Management", href: "/admin" }, // i18n-ignore
        parentAppId: "admin",
        sections: [
            {
                label: "Integrations", // i18n-ignore
                href: "/admin/integrations",
                adminOnly: true,
                icon: Blocks,
                keywords: ["github", "cloudflare", "connect"]
            },
            {
                label: "AI provider keys", // i18n-ignore
                href: "/admin/integrations/models",
                adminOnly: true,
                icon: Sparkles,
                keywords: [
                    "models",
                    "providers",
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
            {
                label: "Agent defaults", // i18n-ignore
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
                ]
            }
        ]
    },
    {
        id: "admin-storage",
        label: "Storage & data", // i18n-ignore
        icon: HardDrive,
        base: "/admin/storage",
        match: ["/admin/uploads", "/admin/retention"],
        parent: { label: "Management", href: "/admin" }, // i18n-ignore
        parentAppId: "admin",
        sections: [
            {
                label: "Storage locations", // i18n-ignore
                href: "/admin/storage",
                adminOnly: true,
                icon: HardDrive,
                keywords: [
                    "storage",
                    "nas",
                    "smb",
                    "nfs",
                    "cifs",
                    "share",
                    "disk",
                    "volumes",
                    "move",
                    "space",
                    "full"
                ]
            },
            {
                label: "Uploads", // i18n-ignore
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
                ]
            },
            {
                label: "Keeping records", // i18n-ignore
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
                    "disk",
                    "mail",
                    "bodies",
                    "cache"
                ]
            }
        ]
    },
    {
        id: "admin-usage",
        label: "Usage & health", // i18n-ignore
        icon: Gauge,
        base: "/admin/consumption",
        match: ["/admin/billing", "/admin/diagnostics"],
        parent: { label: "Management", href: "/admin" }, // i18n-ignore
        parentAppId: "admin",
        sections: [
            {
                label: "Consumption", // i18n-ignore
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
                ]
            },
            {
                label: "Billing", // i18n-ignore
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
                ]
            },
            {
                label: "Diagnostics", // i18n-ignore
                href: "/admin/diagnostics",
                adminOnly: true,
                icon: Stethoscope,
                keywords: ["health", "doctor", "speed test", "support bundle", "troubleshoot"]
            }
        ]
    }
];

/** An area's entry in the Management rail: it opens on the area's first screen,
 *  and search finds it by any of its screens' names. Administrators only unless
 *  one of its screens is open to somebody else. */
function areaEntry(area: AppSubapp): AppSection {
    const open = area.sections.find((section) => !section.adminOnly);
    return {
        label: area.label,
        href: area.base,
        icon: area.icon,
        ...(open ? { needs: open.needs } : { adminOnly: true }),
        keywords: area.sections.flatMap((section) => [section.label, ...(section.keywords ?? [])]),
        group: ADMIN_AREAS_GROUP
    };
}

export const APP_SECTIONS: Record<string, AppSection[]> = {
    drive: [
        {
            label: "Overview", // i18n-ignore
            href: "/drive/overview",
            icon: LayoutDashboard,
            keywords: ["usage", "storage"]
        },
        { label: "Files", href: "/drive", icon: FolderOpen, keywords: ["browse", "folders"] }, // i18n-ignore
        {
            label: "Shared", // i18n-ignore
            href: "/drive/shared",
            icon: Share2,
            keywords: ["shared with me", "people", "sent me", "gave me", "access"]
        },
        { label: "Favorites", href: "/drive/favorites", icon: Star, keywords: ["starred"] }, // i18n-ignore
        { label: "Recent", href: "/drive/recent", icon: Clock }, // i18n-ignore
        {
            label: "Shared links", // i18n-ignore
            href: "/drive/shared-links",
            icon: Link2,
            keywords: ["shares", "public"]
        },
        {
            label: "Snippets", // i18n-ignore
            href: "/drive/snippets",
            needs: "snippets.read",
            icon: Code2,
            keywords: ["paste", "pastebin", "code", "text", "env", "secret", "gist", "share text"]
        },
        {
            label: "Drop points", // i18n-ignore
            href: "/drive/drop-points",
            icon: Inbox,
            keywords: ["file requests", "uploads", "ask for text", "collect"]
        },
        {
            label: "Where the room went", // i18n-ignore
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
        { label: "Trash", href: "/drive/trash", icon: Trash2, keywords: ["deleted", "bin"] } // i18n-ignore
    ],
    vault: [
        {
            label: "Items", // i18n-ignore
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
            label: "Vaults", // i18n-ignore
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
            label: "Sends", // i18n-ignore
            href: "/vault/sends",
            icon: SendHorizontal,
            keywords: ["share a secret", "one time", "send", "hand over"]
        },
        {
            label: "Connect an app", // i18n-ignore
            href: "/vault/clients",
            icon: MonitorSmartphone,
            keywords: ["bitwarden", "browser extension", "cli", "desktop", "mobile", "sync"]
        },
        {
            label: "Settings", // i18n-ignore
            href: "/vault/settings",
            icon: SlidersHorizontal,
            keywords: ["master password", "kdf", "argon2", "export", "delete vault"]
        }
    ],
    games: [
        {
            // Out of the rail: the app is this one screen, and a rail listing it
            // alone beside itself would be a column of nothing. Kept so search
            // still finds it by the games it runs.
            label: "Servers", // i18n-ignore
            href: "/apps/games",
            needs: "games.read",
            requiresApp: "game-servers",
            icon: Gamepad2,
            hidden: true,
            keywords: [
                "minecraft",
                "java",
                "bedrock",
                "ark",
                "survival evolved",
                "fivem",
                "players",
                "console",
                "rcon",
                "mods",
                "plugins"
            ]
        }
    ],
    apps: [
        {
            label: "Deploy", // i18n-ignore
            href: "/apps/deploy",
            icon: Rocket,
            keywords: ["projects", "services", "docker"]
        },
        {
            label: "Marketplace", // i18n-ignore
            href: "/apps/marketplace",
            icon: Store,
            keywords: ["install", "catalog"]
        },
        {
            label: "Agents", // i18n-ignore
            href: "/apps/agents",
            needs: "agents.read",
            icon: Bot,
            keywords: ["coding agent", "ai", "review", "pull requests", "issues", "github"],
            group: DEVELOPMENT_GROUP
        },
        {
            label: "Code", // i18n-ignore
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
            ],
            group: DEVELOPMENT_GROUP
        },
        {
            label: "Runners", // i18n-ignore
            href: "/apps/runners",
            needs: "system.manage",
            icon: Workflow,
            keywords: ["github actions", "ci"],
            group: DEVELOPMENT_GROUP
        },
        {
            label: "Servers", // i18n-ignore
            href: "/apps/servers",
            needs: "system.manage",
            icon: Server,
            keywords: ["hosts", "machines", "ssh"],
            group: MACHINES_GROUP
        },
        {
            label: "Compare", // i18n-ignore
            href: "/apps/servers/compare",
            needs: "system.manage",
            icon: GitCompareArrows,
            keywords: ["side by side", "cpu", "memory", "disk", "network", "load"],
            group: MACHINES_GROUP
        },
        {
            label: "Insights", // i18n-ignore
            href: "/apps/servers/insights",
            needs: "system.manage",
            icon: ChartLine,
            keywords: ["anomalies", "unusual", "forecast", "disk full", "capacity", "trend"],
            group: MACHINES_GROUP
        },
        {
            label: "Rollouts", // i18n-ignore
            href: "/apps/servers/rollouts",
            needs: "system.manage",
            icon: Rocket,
            keywords: ["agent", "update", "waves", "canary", "pin", "queue", "offline commands"],
            group: MACHINES_GROUP
        },
        {
            // Part of Servers on every Polaris (see `native-apps`); the same
            // permission its screen and every one of its actions asks.
            label: "Security scans", // i18n-ignore
            href: "/apps/servers/security",
            needs: "system.manage",
            icon: ScanSearch,
            keywords: [
                "security",
                "malware",
                "antivirus",
                "quarantine",
                "file integrity",
                "hardening",
                "vulnerabilities",
                "cve",
                "sbom"
            ],
            group: MACHINES_GROUP
        },
        {
            label: "Cloud servers", // i18n-ignore
            href: "/apps/servers/cloud",
            needs: "system.manage",
            icon: Cloud,
            keywords: [
                "cloud",
                "digitalocean",
                "hetzner",
                "vultr",
                "linode",
                "aws",
                "azure",
                "google cloud",
                "ionos",
                "vps",
                "cost"
            ],
            group: MACHINES_GROUP
        },
        {
            label: "Containers", // i18n-ignore
            href: "/apps/containers",
            icon: Container,
            keywords: ["docker"],
            group: MACHINES_GROUP
        },
        {
            label: "Tunnels", // i18n-ignore
            href: "/apps/tunnels",
            needs: "deploy.manage",
            icon: Network,
            keywords: ["wireguard", "nat", "cgnat", "expose", "public address", "vpn"],
            group: NETWORK_GROUP
        },
        {
            label: "Firewall", // i18n-ignore
            href: "/apps/firewall",
            needs: "deploy.manage",
            icon: ShieldCheck,
            keywords: ["waf", "ip", "allowlist", "denylist", "block", "access"],
            group: NETWORK_GROUP
        },
        {
            // With the tunnels and the firewall: a service the operator runs for
            // their network. Only here once it is installed, and only for an
            // administrator - it answers every device's lookups.
            label: "Network filter", // i18n-ignore
            href: "/apps/network-filter",
            adminOnly: true,
            requiresApp: "dns-blocker",
            icon: ShieldBan,
            keywords: [...DNS_BLOCKER_KEYWORDS],
            group: NETWORK_GROUP
        },
        {
            label: "Databases", // i18n-ignore
            href: "/apps/databases",
            icon: Database,
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
            ],
            group: DATA_GROUP
        },
        {
            label: "Backups", // i18n-ignore
            href: "/apps/backups",
            adminOnly: true,
            icon: Archive,
            keywords: ["restore", "snapshots"],
            group: DATA_GROUP
        },
        {
            // Here rather than under Management: a mail server is a service the
            // operator runs on their machines, deployed through Deploy and backed
            // up by Backups, beside which it sits. Management configures Polaris
            // itself; reading mail stays in Mail. Only here once somebody installs
            // it from the marketplace: a Polaris that runs no mail server should
            // not carry a door onto one.
            label: "Mail server", // i18n-ignore
            href: "/apps/mail-server",
            needs: "mailserver.manage",
            requiresApp: "mail-server",
            icon: Mails,
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
            ],
            group: DATA_GROUP
        },
        {
            label: "Analytics", // i18n-ignore
            href: "/apps/analytics",
            needs: "deploy.manage",
            icon: ChartColumn,
            keywords: ["visitors", "traffic", "pageviews", "referrers", "metrics", "umami"],
            group: OBSERVABILITY_GROUP
        },
        {
            label: "Telemetry", // i18n-ignore
            href: "/apps/telemetry",
            needs: "deploy.manage",
            icon: Bug,
            keywords: [
                "errors",
                "exceptions",
                "crashes",
                "stack trace",
                "sentry",
                "issues",
                "logging"
            ],
            group: OBSERVABILITY_GROUP
        }
    ],
    watch: [
        {
            label: "Overview", // i18n-ignore
            href: "/watch",
            needs: "deploy.read",
            icon: LayoutDashboard,
            keywords: ["monitoring", "health"]
        },
        {
            label: "Servers", // i18n-ignore
            href: "/watch/servers",
            needs: "deploy.read",
            reachedBy: "place.server",
            icon: Server,
            keywords: ["hosts", "machines", "load"]
        },
        {
            label: "Services", // i18n-ignore
            href: "/watch/services",
            needs: "deploy.read",
            icon: Rocket,
            keywords: ["apps", "deploys", "cpu", "memory"]
        },
        {
            label: "Containers", // i18n-ignore
            href: "/watch/containers",
            icon: Container,
            needs: "deploy.read",
            keywords: ["docker"]
        },
        {
            label: "Connectivity", // i18n-ignore
            href: "/watch/connectivity",
            icon: Wifi,
            adminOnly: true,
            reachedBy: "watch.connectivity",
            keywords: [
                "internet",
                "outages",
                "offline",
                "uptime",
                "downtime",
                "connection",
                "line",
                "isp",
                "availability"
            ]
        },
        {
            label: "Alarms", // i18n-ignore
            href: "/watch/alarms",
            needs: "deploy.read",
            icon: Bell,
            keywords: ["thresholds", "alerts", "events"]
        },
        {
            label: "Webhooks", // i18n-ignore
            href: "/watch/webhooks",
            needs: "deploy.read",
            icon: Webhook,
            keywords: ["discord", "slack", "endpoints"]
        }
    ],
    home: [
        {
            // The landing page: the place at a glance, rooms and cameras together.
            label: "Overview", // i18n-ignore
            href: "/places",
            icon: LayoutDashboard,
            keywords: [
                "home",
                "summary",
                "rooms",
                "areas",
                "dashboard",
                "lights on",
                "climate",
                "what needs attention"
            ]
        },
        {
            // The wall and the camera settings are one screen; /places/live
            // redirects here.
            label: "Cameras", // i18n-ignore
            href: "/places/cameras",
            icon: Cctv,
            group: CAMERAS_GROUP,
            keywords: [
                "live",
                "wall",
                "watch",
                "stream",
                "view",
                "rtsp",
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
            label: "Events", // i18n-ignore
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
            label: "Alerts", // i18n-ignore
            group: CAMERAS_GROUP,
            href: "/places/alerts",
            icon: Bell,
            keywords: ["notify", "tell me", "warn", "rules", "who gets told", "message"]
        },
        {
            label: "Clips", // i18n-ignore
            group: CAMERAS_GROUP,
            href: "/places/clips",
            icon: Video,
            keywords: ["recordings", "footage", "playback", "saved", "download"]
        },
        {
            label: "People", // i18n-ignore
            group: CAMERAS_GROUP,
            href: "/places/people",
            icon: ScanFace,
            keywords: ["faces", "known", "recognition", "family", "strangers"]
        },
        {
            label: "Devices", // i18n-ignore
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
            // Full-screen boards of cards for a tablet on the wall: the devices
            // and rooms somebody picked, with a link for a screen nobody signs in on.
            label: "Wall panels", // i18n-ignore
            group: DEVICES_GROUP,
            href: "/places/panels",
            icon: LayoutGrid,
            keywords: ["wallpanel", "kiosk", "tablet", "dashboard", "wall", "board", "fullscreen"]
        },
        {
            // A UPS is a physical thing in a place, like a door (it was under
            // Servers until 2026-10-20; the old address redirects here). The
            // machines it protects link to it from their own page.
            label: "UPS", // i18n-ignore
            group: DEVICES_GROUP,
            href: "/places/ups",
            needs: "system.manage",
            icon: BatteryCharging,
            keywords: ["ups", "sai", "battery", "power", "outage", "nut", "snmp", "shutdown"]
        },
        {
            // A NAS connected in Drive, seen as the box in a place: its drives,
            // temperatures, fans and backups. Its files stay in Drive.
            label: "NAS", // i18n-ignore
            group: DEVICES_GROUP,
            href: "/places/nas",
            icon: HardDrive,
            keywords: ["nas", "unas", "unifi", "disks", "drives", "raid", "backup", "fan"]
        },
        {
            // Servers, their containers and the domains that answer for them, as
            // devices: load, what is behind it, and the days an alarm fired.
            label: "Machines", // i18n-ignore
            group: DEVICES_GROUP,
            href: "/places/machines",
            icon: Server,
            // Open to everyone, as NAS is: a server or a domain can be lent to
            // somebody without Deploy, and this is the only way they reach it.
            keywords: [
                "server",
                "container",
                "domain",
                "cpu",
                "memory",
                "uptime",
                "outage",
                "watch"
            ]
        },
        {
            label: "Automations", // i18n-ignore
            group: DEVICES_GROUP,
            href: "/places/devices/automations",
            icon: Workflow,
            keywords: [
                "routines",
                "schedule",
                "timer",
                "turn off after",
                "switch off automatically",
                "if this then that",
                "rules",
                "triggers",
                "scenes"
            ]
        },
        {
            label: "Settings", // i18n-ignore
            href: "/places/settings",
            icon: SlidersHorizontal,
            keywords: ["relay", "storage", "retention", "where it runs", "uninstall"]
        }
    ],
    tasks: [
        {
            label: "My work", // i18n-ignore
            href: "/tasks",
            icon: ListTodo,
            keywords: ["home", "assigned", "todo", "my tasks"]
        },
        {
            label: "Everything", // i18n-ignore
            href: "/tasks/everything",
            icon: LayoutGrid,
            keywords: ["all tasks", "across spaces"]
        },
        {
            label: "Sprints", // i18n-ignore
            href: "/tasks/sprints",
            icon: CalendarRange,
            keywords: ["agile", "burndown", "iteration"]
        },
        {
            label: "Goals", // i18n-ignore
            href: "/tasks/goals",
            icon: Target,
            keywords: ["okr", "objectives", "targets"]
        },
        {
            label: "Docs", // i18n-ignore
            href: "/tasks/docs",
            icon: FileText,
            keywords: ["wiki", "notes", "knowledge"]
        },
        {
            label: "Timesheet", // i18n-ignore
            href: "/tasks/time",
            icon: Timer,
            keywords: ["time tracking", "hours", "billable"]
        },
        {
            label: "Reporting", // i18n-ignore
            href: "/tasks/reports",
            icon: ChartColumn,
            keywords: ["dashboard", "workload", "metrics"]
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
            label: "Inbox", // i18n-ignore
            href: "/mail",
            icon: Inbox,
            hidden: true,
            keywords: ["email", "gmail", "imap", "unread", "messages", "correo"]
        },
        {
            label: "Starred", // i18n-ignore
            href: "/mail/starred",
            icon: Star,
            hidden: true,
            keywords: ["flagged", "important"]
        },
        {
            label: "Sent", // i18n-ignore
            href: "/mail/sent",
            icon: SendHorizontal,
            hidden: true,
            keywords: ["outbox", "what I sent"]
        },
        {
            label: "Drafts", // i18n-ignore
            href: "/mail/drafts",
            icon: FileText,
            hidden: true,
            keywords: ["unsent", "scheduled", "send later", "unfinished"]
        },
        {
            label: "Archive", // i18n-ignore
            href: "/mail/archive",
            icon: Archive,
            hidden: true,
            keywords: ["archived", "put away"]
        },
        {
            label: "Spam", // i18n-ignore
            href: "/mail/junk",
            icon: Bug,
            hidden: true,
            keywords: ["junk", "phishing", "unwanted"]
        },
        {
            label: "Trash", // i18n-ignore
            href: "/mail/trash",
            icon: Trash2,
            hidden: true,
            keywords: ["deleted", "bin"]
        },
        {
            label: "Mailboxes", // i18n-ignore
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
            label: "Send-as addresses", // i18n-ignore
            href: "/mail/settings/identities",
            icon: IdCard,
            hidden: true,
            keywords: ["alias", "identity", "from address", "send as"]
        },
        {
            label: "Labels", // i18n-ignore
            href: "/mail/settings/labels",
            icon: Tag,
            hidden: true,
            keywords: ["tag", "colour", "group mail", "categories"]
        },
        {
            label: "Filters", // i18n-ignore
            href: "/mail/settings/rules",
            icon: Workflow,
            hidden: true,
            keywords: ["rules", "sieve", "sort mail", "file automatically", "block sender"]
        },
        {
            label: "Signature", // i18n-ignore
            href: "/mail/settings/signature",
            icon: NotebookPen,
            hidden: true,
            keywords: ["sign off", "footer"]
        },
        {
            label: "Privacy", // i18n-ignore
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
            label: "Away message", // i18n-ignore
            href: "/mail/settings/away",
            icon: CalendarClock,
            hidden: true,
            keywords: ["out of office", "vacation", "holiday", "auto reply", "autoresponder"]
        }
    ],
    crm: [
        {
            label: "Companies", // i18n-ignore
            href: "/crm/companies",
            icon: Building2,
            keywords: ["accounts", "organizations", "customers", "clients", "domains"]
        },
        {
            label: "People", // i18n-ignore
            href: "/crm/people",
            icon: Contact,
            keywords: ["contacts", "leads", "email", "phone", "job title"]
        },
        {
            label: "Opportunities", // i18n-ignore
            href: "/crm/opportunities",
            icon: Target,
            keywords: ["deals", "pipeline", "stages", "sales", "amount", "close date"]
        },
        {
            label: "Dashboards", // i18n-ignore
            href: "/crm/dashboards",
            icon: ChartColumn,
            keywords: ["charts", "reports", "analytics", "pipeline value", "kpi"]
        },
        {
            label: "Forecast", // i18n-ignore
            href: "/crm/forecast",
            icon: TrendingUp,
            keywords: ["sales forecast", "pipeline", "weighted", "quota", "close date", "revenue"]
        },
        {
            label: "Roles", // i18n-ignore
            href: "/crm/roles",
            icon: ShieldCheck,
            keywords: ["permissions", "field access", "hidden fields", "read-only", "own records"]
        },
        {
            label: "Audit log", // i18n-ignore
            href: "/crm/audit",
            icon: History,
            keywords: ["activity", "history", "who changed", "changes", "events", "export"]
        },
        {
            label: "New company", // i18n-ignore
            href: "/crm/companies?new=1",
            icon: Building2,
            keywords: ["create", "add", "account", "customer", "client"],
            hidden: true
        },
        {
            label: "New person", // i18n-ignore
            href: "/crm/people?new=1",
            icon: Contact,
            keywords: ["create", "add", "contact", "lead"],
            hidden: true
        },
        {
            label: "New opportunity", // i18n-ignore
            href: "/crm/opportunities?new=1",
            icon: Target,
            keywords: ["create", "add", "deal"],
            hidden: true
        }
    ],
    automations: [
        {
            label: "Automations", // i18n-ignore
            href: "/automations",
            icon: Workflow,
            keywords: ["workflows", "rules", "triggers", "webhooks", "schedules", "flows"]
        },
        {
            label: "Runs", // i18n-ignore
            href: "/automations/runs",
            icon: History,
            keywords: ["executions", "history", "log", "failed runs"]
        },
        {
            label: "Webhooks", // i18n-ignore
            href: "/automations/webhooks",
            icon: Webhook,
            keywords: [
                "webhook",
                "signed",
                "endpoint",
                "events",
                "integration",
                "headers",
                "bearer",
                "basic auth"
            ]
        },
        {
            label: "Secrets", // i18n-ignore
            href: "/automations/secrets",
            icon: KeyRound,
            keywords: ["tokens", "webhook urls", "credentials", "passwords"]
        }
    ],
    /**
     * Polar draws no rail from here either: its page carries its own list of
     * chats, projects and recents, exactly as Chat and Mail do, and a rail with
     * one entry beside it was two sidebars for one screen. The entry is hidden
     * and stays so the global search still finds the page by name.
     */
    polar: [
        {
            label: "Conversations", // i18n-ignore
            href: "/polar",
            icon: MessagesSquare,
            hidden: true,
            keywords: ["assistant", "ai", "ask", "chat", "history", "polar"]
        },
        {
            label: "Polar settings", // i18n-ignore
            href: "/polar/settings",
            icon: Settings,
            hidden: true,
            keywords: ["memory", "tools", "mcp", "connectors", "web search", "polar"]
        },
        // What Polar may do without asking first: the "Always allow" answers
        // from its approval card, each with Revoke.
        {
            label: "Polar permissions", // i18n-ignore
            href: "/polar/settings#permissions",
            icon: ShieldCheck,
            hidden: true,
            keywords: ["polar", "always allow", "approvals", "permissions", "assistant"]
        }
    ],
    notes: [
        {
            label: "Notes", // i18n-ignore
            href: "/notes",
            icon: NotebookPen,
            keywords: ["notepad", "scratch", "jot", "personal", "private", "markdown", "writing"]
        },
        {
            label: "Archive", // i18n-ignore
            href: "/notes/archive",
            icon: Archive,
            keywords: ["archived", "put away", "old notes", "restore"]
        }
    ],
    account: [
        {
            label: "Profile", // i18n-ignore
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
            label: "Account", // i18n-ignore
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
            label: "Account standing", // i18n-ignore
            href: "/account/standing",
            icon: BadgeCheck,
            keywords: ["moderation", "warnings", "suspended", "reports", "timeout", "ban", "rules"]
        },
        {
            label: "Preferences", // i18n-ignore
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
        {
            label: "Keyboard shortcuts", // i18n-ignore
            href: "/account/shortcuts",
            icon: Keyboard,
            keywords: ["keys", "keybindings", "hotkeys", "shortcuts"]
        },
        // Every way of having Polaris somewhere other than a tab. One screen
        // rather than a card under whichever page happened to build each one:
        // somebody after "the app" was having to know that the desktop offer was
        // under Preferences and the extension under the vault's client screen.
        {
            label: "Downloads", // i18n-ignore
            href: "/account/downloads",
            icon: Download,
            keywords: [
                "app",
                "apps",
                "desktop",
                "windows",
                "macos",
                "linux",
                "android",
                "ios",
                "mobile",
                "phone",
                "extension",
                "chrome",
                "firefox",
                "install",
                "cli",
                "command line",
                "tunnel"
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
            label: "Voice & Video", // i18n-ignore
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
            label: "Privacy", // i18n-ignore
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
            label: "Activity sharing", // i18n-ignore
            href: "/account/privacy/activity",
            icon: Gamepad2,
            keywords: [
                "activity",
                "activity status",
                "activity privacy",
                "privacy",
                "playing",
                "now playing",
                "listening",
                "spotify",
                "music",
                "games",
                "registered games",
                "detected games",
                "minecraft",
                "rich presence"
            ],
            group: PRIVACY_GROUP
        },
        {
            label: "Status schedule", // i18n-ignore
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
            label: "Friends", // i18n-ignore
            href: "/account/friends",
            icon: Users,
            keywords: ["friend", "request", "add somebody", "contacts"],
            group: PRIVACY_GROUP
        },
        {
            label: "Notifications", // i18n-ignore
            href: "/account/notifications",
            icon: Bell,
            keywords: ["alerts", "email"]
        },
        {
            label: "Connected accounts", // i18n-ignore
            href: "/account/connections",
            icon: Link2,
            keywords: [
                "github",
                "google",
                "link",
                "oauth",
                "repositories",
                "calendar",
                "linear",
                "jira",
                "trackers"
            ]
        },
        {
            label: "Organizations", // i18n-ignore
            href: "/account/organizations",
            icon: Building2,
            keywords: ["org", "orgs", "teams", "company", "members", "roster", "group"]
        },
        // Everything that decides who reaches this account is one subject, and it
        // is half the rail: five screens people go looking for together.
        {
            label: "Password & 2FA", // i18n-ignore
            href: "/account/security",
            icon: ShieldCheck,
            keywords: ["password", "2fa", "two-factor", "passkey", "security"],
            group: "Security"
        },
        {
            label: "Sessions", // i18n-ignore
            href: "/account/sessions",
            icon: MonitorSmartphone,
            keywords: ["devices", "sign out", "remembered devices", "trusted devices"],
            group: "Security"
        },
        {
            label: "Activity", // i18n-ignore
            href: "/account/activity",
            icon: History,
            keywords: ["audit", "logs", "history", "what happened"],
            group: "Security"
        },
        {
            label: "Scan a code", // i18n-ignore
            href: "/account/scan",
            icon: ScanLine,
            keywords: ["qr", "sign in", "approve", "camera"],
            group: "Security"
        },
        {
            label: "Access rules", // i18n-ignore
            href: "/account/access",
            icon: Network,
            keywords: ["ip", "country", "geo"],
            group: "Security"
        },
        // What somebody building on Polaris reaches for: the keys a script or an
        // integration signs in with, their own model keys, and the domains their
        // deploys answer on. Under Security it read as a sign-in setting, and
        // mixed into the account's own list it was hard to find.
        {
            label: "API keys", // i18n-ignore
            href: "/account/api-keys",
            icon: KeyRound,
            keywords: ["tokens", "developers", "integrations"],
            group: DEVELOPERS_GROUP
        },
        // Assistants connected over MCP: the list of what each may do, and how
        // to connect one. Their own screen rather than a card under API keys,
        // because nobody connecting ChatGPT thinks of it as making a key.
        {
            label: "AI assistants", // i18n-ignore
            href: "/account/assistants",
            icon: Bot,
            keywords: [
                "mcp",
                "claude",
                "claude code",
                "chatgpt",
                "openai",
                "cursor",
                "vs code",
                "codex",
                "connected apps",
                "connectors",
                "oauth"
            ],
            group: DEVELOPERS_GROUP
        },
        {
            label: "AI provider keys", // i18n-ignore
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
            ],
            group: DEVELOPERS_GROUP
        },
        {
            label: "Domains", // i18n-ignore
            href: "/account/domains",
            icon: Globe,
            keywords: ["dns", "custom domain", "deploys", "hostnames", "wildcard", "own domain"],
            group: DEVELOPERS_GROUP
        }
    ],
    office: [
        {
            label: "Recent", // i18n-ignore
            href: "/office",
            icon: Clock,
            keywords: ["all", "documents", "files", "everything"]
        },
        { label: "Starred", href: "/office/starred", icon: Star, keywords: ["favourites"] }, // i18n-ignore
        {
            label: "Shared with me", // i18n-ignore
            href: "/office/shared",
            icon: Users,
            keywords: ["gave me", "sent me", "access"]
        },
        {
            label: "Documents", // i18n-ignore
            href: "/office/kind/doc",
            icon: FileText,
            group: "Kinds",
            keywords: ["docs", "word", "docx", "writing"]
        },
        {
            label: "Spreadsheets", // i18n-ignore
            href: "/office/kind/sheet",
            icon: Table2,
            group: "Kinds",
            keywords: ["sheets", "excel", "xlsx", "formulas", "numbers"]
        },
        {
            label: "Presentations", // i18n-ignore
            href: "/office/kind/slides",
            icon: Presentation,
            group: "Kinds",
            keywords: ["slides", "powerpoint", "pptx", "deck"]
        },
        {
            label: "Diagrams", // i18n-ignore
            href: "/office/kind/diagram",
            icon: Workflow,
            group: "Kinds",
            keywords: ["draw", "whiteboard", "flowchart", "architecture"]
        },
        {
            label: "Comparisons", // i18n-ignore
            href: "/office/kind/comparison",
            icon: Columns3,
            group: "Kinds",
            keywords: ["competitors", "battlecard", "matrix", "vendors", "alternatives"]
        },
        {
            label: "Archive", // i18n-ignore
            href: "/office/archive",
            icon: Archive,
            group: "Filed",
            keywords: ["archived", "put away"]
        },
        {
            label: "Trash", // i18n-ignore
            href: "/office/trash",
            icon: Trash2,
            group: "Filed",
            keywords: ["bin", "deleted", "removed"]
        }
    ],
    admin: [
        { label: "Overview", href: "/admin", adminOnly: true, icon: LayoutDashboard }, // i18n-ignore
        {
            label: "Activity", // i18n-ignore
            href: "/admin/activity",
            adminOnly: true,
            icon: Activity,
            keywords: ["audit", "logs"]
        },
        {
            label: "Evidence", // i18n-ignore
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
        ...ADMIN_AREAS.flatMap((area) =>
            area.id === "admin-communication"
                ? [
                      areaEntry(area),
                      {
                          // The messaging bridge's two-way chat. Only here once the bridge is
                          // installed: without it nothing on these screens can connect or send.
                          label: "Inbox", // i18n-ignore
                          href: "/admin/inbox",
                          requiresApp: "messaging-bridge",
                          group: ADMIN_AREAS_GROUP,
                          icon: MessagesSquare,
                          keywords: [
                              "conversations",
                              "chats",
                              "messages",
                              "whatsapp",
                              "telegram",
                              "slack",
                              "contacts"
                          ]
                      }
                  ]
                : [areaEntry(area)]
        )
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
    /** Further paths it owns, for a subject whose screens share no prefix -
     *  a Management area keeps the addresses its screens had before it. */
    match?: string[];
    parent: { label: string; href: string };
    /** The app "back" returns to, when not everybody who reaches this subject can
     *  open it. Inbox is Management's, and a member holds `inbox.read` without
     *  holding anything else in Management - so for them the way back is a door
     *  that refuses them, and the rail leaves it out rather than drawing it. */
    parentAppId?: string;
    sections: AppSection[];
}

export const APP_SUBAPPS: AppSubapp[] = [
    ...ADMIN_AREAS,
    {
        id: "inbox",
        label: "Inbox", // i18n-ignore
        icon: MessagesSquare,
        base: "/admin/inbox",
        parent: { label: "Management", href: "/admin" }, // i18n-ignore
        parentAppId: "admin",
        sections: [
            {
                label: "Conversations", // i18n-ignore
                href: "/admin/inbox",
                icon: MessagesSquare,
                keywords: ["chats", "messages"]
            },
            {
                label: "Contacts", // i18n-ignore
                href: "/admin/inbox/contacts",
                icon: Contact,
                keywords: ["people"]
            },
            {
                label: "Channels", // i18n-ignore
                href: "/admin/inbox/channels",
                icon: Radio,
                keywords: ["whatsapp", "telegram", "slack", "discord"]
            },
            { label: "Logs", href: "/admin/inbox/logs", icon: ScrollText } // i18n-ignore
        ]
    },
    {
        id: "agents",
        label: "Agents", // i18n-ignore
        icon: Bot,
        base: "/apps/agents",
        parent: { label: "Apps", href: "/apps/deploy" }, // i18n-ignore
        sections: [
            {
                label: "Overview", // i18n-ignore
                href: "/apps/agents",
                icon: LayoutDashboard,
                keywords: ["agents", "coding agent", "ai", "summary"]
            },
            {
                label: "Repositories", // i18n-ignore
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
                label: "Automations", // i18n-ignore
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
                label: "Sessions", // i18n-ignore
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
                label: "Runs", // i18n-ignore
                href: "/apps/agents/runs",
                needs: "agents.read",
                icon: History,
                keywords: ["history", "logs", "failed", "what happened"]
            },
            {
                label: "Settings", // i18n-ignore
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
                label: "Set up", // i18n-ignore
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
        label: "Runners", // i18n-ignore
        icon: Workflow,
        base: "/apps/runners",
        parent: { label: "Apps", href: "/apps/deploy" }, // i18n-ignore
        sections: [
            {
                label: "Pools", // i18n-ignore
                href: "/apps/runners",
                icon: Workflow,
                keywords: ["runners", "github actions", "ci", "machines", "self-hosted"]
            },
            {
                label: "Repositories", // i18n-ignore
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
                label: "Runs", // i18n-ignore
                href: "/apps/runners/runs",
                needs: "system.manage",
                icon: History,
                keywords: ["history", "jobs", "workflow runs", "builds", "logs", "failed"]
            },
            {
                label: "Secrets", // i18n-ignore
                href: "/apps/runners/secrets",
                needs: "system.manage",
                icon: KeyRound,
                keywords: ["variables", "env", "credentials", "tokens", "passwords"]
            },
            {
                label: "How it works", // i18n-ignore
                href: "/apps/runners/guide",
                needs: "system.manage",
                icon: BookOpen,
                keywords: ["help", "setup", "runs-on", "getting started", "guide", "docs"]
            }
        ]
    },
    {
        // Laid out the way Pi-hole's own sidebar is, which is where somebody who
        // has run one looks for each of these. Every screen is the installed
        // app's and an administrator's, like the Apps entry that leads here.
        id: "dns-blocker",
        label: "Network filter", // i18n-ignore
        icon: ShieldBan,
        base: "/apps/network-filter",
        parent: { label: "Apps", href: "/apps/deploy" }, // i18n-ignore
        sections: [
            {
                label: "Overview", // i18n-ignore
                href: "/apps/network-filter",
                adminOnly: true,
                requiresApp: "dns-blocker",
                icon: LayoutDashboard,
                keywords: ["dashboard", "pause", "status", "router"]
            },
            {
                label: "Query log", // i18n-ignore
                href: "/apps/network-filter/log",
                adminOnly: true,
                requiresApp: "dns-blocker",
                icon: ScrollText,
                keywords: ["queries", "lookups", "live", "tail", "blocked domains"]
            },
            {
                label: "Lists", // i18n-ignore
                href: "/apps/network-filter/lists",
                adminOnly: true,
                requiresApp: "dns-blocker",
                icon: ShieldBan,
                keywords: [
                    "blocklists",
                    "adlists",
                    "allowlist",
                    "denylist",
                    "services",
                    "schedules"
                ]
            },
            {
                label: "Devices", // i18n-ignore
                href: "/apps/network-filter/devices",
                adminOnly: true,
                requiresApp: "dns-blocker",
                icon: MonitorSmartphone,
                keywords: ["clients", "network", "groups", "names"]
            },
            {
                label: "Local DNS", // i18n-ignore
                href: "/apps/network-filter/local-dns",
                adminOnly: true,
                requiresApp: "dns-blocker",
                icon: Network,
                keywords: ["records", "cname", "aliases", "conditional forwarding"]
            },
            {
                label: "Settings", // i18n-ignore
                href: "/apps/network-filter/settings",
                adminOnly: true,
                requiresApp: "dns-blocker",
                icon: SlidersHorizontal,
                keywords: ["upstream", "safe search", "cache", "export", "import", "backup"]
            }
        ]
    }
];

/** Where an installed app's own screens live. */
export const INSTALLED_BASE = "/apps/installed";

const RUNNING_GROUP = "Running it";
const TALKING_GROUP = "Talking to players";
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
        label: "Overview", // i18n-ignore
        icon: LayoutDashboard,
        keywords: ["status", "address", "players online"]
    },
    console: {
        label: "Console", // i18n-ignore
        icon: Terminal,
        group: RUNNING_GROUP,
        keywords: ["commands", "rcon", "logs", "say"]
    },
    players: {
        label: "Players", // i18n-ignore
        icon: Users,
        group: RUNNING_GROUP,
        keywords: ["who is on", "kick", "ban", "op", "inventory", "give item"]
    },
    usage: {
        label: "Usage", // i18n-ignore
        icon: ChartColumn,
        group: RUNNING_GROUP,
        keywords: ["cpu", "memory", "history", "metrics"]
    },
    announce: {
        label: "Announce", // i18n-ignore
        icon: Megaphone,
        group: TALKING_GROUP,
        keywords: [
            "title",
            "subtitle",
            "action bar",
            "broadcast",
            "tellraw",
            "sound",
            "message everybody"
        ]
    },
    panel: {
        label: "Side panel", // i18n-ignore
        icon: PanelRight,
        group: TALKING_GROUP,
        keywords: [
            "scoreboard",
            "sidebar",
            "leaderboard",
            "ranking",
            "last death",
            "levels",
            "who is online"
        ]
    },
    sounds: {
        label: "Sounds", // i18n-ignore
        icon: Music,
        group: TALKING_GROUP,
        keywords: [
            "custom sounds",
            "resource pack",
            "music",
            "upload",
            "ogg",
            "mp3",
            "join sound",
            "victory"
        ]
    },
    chat: {
        label: "Linked chat", // i18n-ignore
        icon: MessagesSquare,
        group: TALKING_GROUP,
        keywords: [
            "chat group",
            "space",
            "channel",
            "call",
            "voice",
            "commands",
            "online",
            "status",
            "relay",
            "discord"
        ]
    },
    events: {
        label: "Events", // i18n-ignore
        icon: PartyPopper,
        group: TALKING_GROUP,
        keywords: [
            "event",
            "competition",
            "minigame",
            "tournament",
            "mining rush",
            "boss",
            "trivia",
            "blood moon",
            "supply drop",
            "prizes",
            "rewards"
        ]
    },
    challenges: {
        label: "Challenges", // i18n-ignore
        icon: Trophy,
        group: TALKING_GROUP,
        keywords: [
            "challenge",
            "retos",
            "daily",
            "weekly",
            "quests",
            "missions",
            "season pass",
            "battle pass",
            "bingo",
            "streak",
            "community goal"
        ]
    },
    schedule: {
        label: "Schedule", // i18n-ignore
        icon: CalendarClock,
        group: RUNNING_GROUP,
        keywords: ["restart", "backup", "sleep", "wake on join", "automatic", "timer"]
    },
    world: {
        label: "World", // i18n-ignore
        icon: Globe,
        group: CONTENT_GROUP,
        keywords: ["level", "seed", "backups", "restore", "new world"]
    },
    rules: {
        label: "Rules", // i18n-ignore
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
        label: "Mods", // i18n-ignore
        icon: Blocks,
        group: CONTENT_GROUP,
        keywords: ["plugins", "datapacks", "modrinth", "fabric", "forge"]
    },
    access: {
        label: "Access", // i18n-ignore
        icon: IdCard,
        group: ACCESS_GROUP,
        keywords: ["invite", "who can manage", "moderator", "grants"]
    },
    security: {
        label: "Security", // i18n-ignore
        icon: ShieldCheck,
        group: ACCESS_GROUP,
        keywords: ["whitelist", "bans", "firewall", "addresses"]
    },
    anticheat: {
        label: "Anti-cheat", // i18n-ignore
        icon: ScanFace,
        group: ACCESS_GROUP,
        keywords: [
            "x-ray",
            "xray",
            "honeypot",
            "cheating",
            "flying",
            "fly hack",
            "teleport",
            "diamonds"
        ]
    },
    ranks: {
        label: "Ranks", // i18n-ignore
        icon: Crown,
        group: TALKING_GROUP,
        keywords: [
            "rank",
            "rangos",
            "prefix",
            "tag",
            "team",
            "tab list",
            "chat colour",
            "admin",
            "vip"
        ]
    },
    moderation: {
        label: "Moderation", // i18n-ignore
        icon: MessageSquareWarning,
        group: TALKING_GROUP,
        keywords: [
            "spam",
            "announcement",
            "securitycraft",
            "thanks message",
            "advertising",
            "chat filter"
        ]
    },
    settings: {
        label: "Settings", // i18n-ignore
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
        parent: { label: "Game servers", href: "/apps/games" }, // i18n-ignore
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
        parent: { label: "Organizations", href: ORG_BASE }, // i18n-ignore
        sections: [
            {
                label: "Overview", // i18n-ignore
                href: base,
                icon: LayoutDashboard,
                keywords: ["organization", "summary"]
            },
            {
                label: "People", // i18n-ignore
                href: `${base}/people`,
                icon: Users,
                keywords: ["members", "roster", "who", "invite", "add somebody"]
            },
            {
                label: "Teams", // i18n-ignore
                href: `${base}/teams`,
                icon: UsersRound,
                keywords: ["groups", "squads", "access", "grants"]
            },
            {
                label: "Roles", // i18n-ignore
                href: `${base}/roles`,
                icon: IdCard,
                permission: "roles.manage",
                keywords: ["permissions", "what they can do", "admin", "member"]
            },
            {
                label: "Spaces", // i18n-ignore
                href: `${base}/spaces`,
                icon: SquareCheckBig,
                keywords: ["tasks", "work", "boards", "lists", "projects"]
            },
            {
                label: "Mailboxes", // i18n-ignore
                href: `${base}/mailboxes`,
                icon: Mail,
                permission: "mail.manage",
                keywords: ["email", "addresses", "company address", "support", "hand out"]
            },
            {
                label: "Domains", // i18n-ignore
                href: `${base}/domains`,
                icon: Globe,
                permission: "domains.manage",
                keywords: ["dns", "deploys", "hostnames", "custom domain", "wildcard"]
            },
            {
                // Everybody on the roster sees what the organization has
                // connected; only its managers are offered Connect and Remove.
                label: "Connected accounts", // i18n-ignore
                href: `${base}/connections`,
                icon: Link2,
                keywords: ["connections", "cloud", "accounts", "providers", "api token"]
            },
            {
                label: "Billing", // i18n-ignore
                href: `${base}/billing`,
                icon: Wallet,
                permission: "settings.manage",
                keywords: [
                    "cost",
                    "costs",
                    "budget",
                    "spend",
                    "statement",
                    "invoice",
                    "usage",
                    "charge back"
                ]
            },
            {
                // Everybody on the roster can see what the organization may hold;
                // only a platform administrator can change it, on the screen itself.
                label: "Limits", // i18n-ignore
                href: `${base}/limits`,
                icon: Gauge,
                keywords: ["quota", "quotas", "caps", "how many", "allowance", "usage"]
            },
            {
                label: "Activity", // i18n-ignore
                href: `${base}/activity`,
                icon: History,
                permission: "activity.read",
                keywords: ["audit", "history", "logs", "what happened", "who did"]
            },
            {
                label: "Settings", // i18n-ignore
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
        APP_SUBAPPS.find((sub) =>
            [sub.base, ...(sub.match ?? [])].some(
                (root) => pathname === root || pathname.startsWith(`${root}/`)
            )
        ) ?? null
    );
}

/** How specific an app's claim on a path is: the longest of its own subtree and
 *  its extra `match` prefixes that owns it, or -1 when none does. */
function claimOn(app: AppEntry, pathname: string): number {
    const owns = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
    return Math.max(
        -1,
        ...[app.href, ...(app.match ?? [])].filter(owns).map((base) => base.length)
    );
}

/** The app the current path belongs to, defaulting to the first app (Overview),
 *  which is the one screen that belongs to no app in particular.
 *
 *  The most specific claim wins: Apps owns `/apps`, and Game servers answers
 *  inside it at `/apps/games`. */
export function resolveActiveApp(pathname: string): AppEntry {
    let best: AppEntry | null = null;
    let bestClaim = -1;
    for (const app of POLARIS_APPS) {
        const claim = claimOn(app, pathname);
        if (claim > bestClaim) {
            best = app;
            bestClaim = claim;
        }
    }
    // POLARIS_APPS is a non-empty literal, so [0] is always present.
    return best ?? POLARIS_APPS[0]!;
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
