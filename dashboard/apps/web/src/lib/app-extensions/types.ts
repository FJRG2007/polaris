/**
 * What core may ask of an installable app.
 *
 * Core never imports an app's modules. Everything it needs from one - a job to
 * run, a backup source, a panel to draw, the ports a router must forward - it
 * asks the app extension registry, and an app that is not there answers
 * nothing. That is what lets an app's code be absent from a server that has not
 * installed it (docs/installable-apps-plan.md).
 *
 * Every hook is optional: an app implements the ones it has something to say
 * about. Everything here is a type, so this module is shared by core and apps.
 */

import type { McpTool } from "@/lib/mcp/protocol";
import type { PendingAppLink } from "@polaris/core";
import type { McpSearchProvider } from "@/lib/mcp/search";
import type { BackupSource } from "@/lib/backups/sources/types";
import type { GamePortRow, GamePortsReading } from "@/lib/apps/port-advice";

/** A scheduled job an app runs. Keyed like core's own; the key names the lease. */
export interface AppJob {
    readonly key: string;
    readonly everyMs: number;
    readonly leaseMs: number | null;
    readonly run: () => Promise<unknown>;
}

/**
 * Something an app draws inside a core screen.
 *
 * Built on the server, where the app reads what it needs, and drawn on the
 * client by the app's own component, looked up by `app` and `kind`. `props` is
 * whatever that component takes; core only carries it.
 */
export interface AppSlot {
    readonly app: string;
    readonly kind: string;
    readonly props: unknown;
    /** Where the component that draws it is, when the app came as a bundle. */
    readonly bundle?: { readonly src: string; readonly name: string };
}

/** One game server, as the overview card needs it. */
export interface GameServerSummary {
    readonly id: string;
    readonly name: string;
    readonly game: string | null;
    readonly catalogName: string;
    readonly serverName: string | null;
    readonly running: boolean;
    readonly slots: number | null;
}

/** One event coming up, as the Overview card lists it. */
export interface UpcomingEvent {
    readonly id: string;
    readonly title: string;
    /** ISO instant; for an all-day event, midnight UTC of its date. */
    readonly start: string;
    readonly allDay: boolean;
    readonly color: string;
    readonly href: string;
}

/** The install a panel is drawn for. */
export interface ExtensionInstall {
    readonly id: string;
    readonly catalogId: string;
    readonly applicationId: string | null;
    readonly ownerId: string;
}

export interface AppExtension {
    /** The catalog id of the app, the one its install row carries. */
    readonly id: string;

    /** The scheduled jobs it runs. They only run while it is installed. */
    readonly jobs?: () => readonly AppJob[];

    /** The backup sources it provides, by resource kind. */
    readonly backupSources?: () => Readonly<Partial<Record<BackupSource["kind"], BackupSource>>>;

    /** The image a release of one of its services runs, when the app decides it
     *  rather than the stored one. Undefined leaves the stored image alone. */
    readonly releaseImage?: (
        storedImage: string | undefined,
        env: Readonly<Record<string, string>>
    ) => string | undefined;

    /** Whether an install's settings describe a server that loads plugins, which
     *  decides whether plugin-only settings are kept when it is installed. Null
     *  for a catalog app this extension does not know. */
    readonly pluginServer?: (catalogId: string, env: ReadonlyMap<string, string>) => boolean | null;

    /** Before one of its installs is stopped or redeployed: write out what only
     *  lives in memory. */
    readonly beforeStop?: (ownerId: string, installedAppId: string) => Promise<void>;

    /** When one of its installs is started by hand. */
    readonly afterStart?: (installedAppId: string) => Promise<void>;

    /**
     * A container was found running under one of its services that is recorded
     * as stopped. True when the app takes the service as running again - its own
     * guard stopped it, and somebody has since brought it up - and has recorded
     * that, so the container is left alone rather than stopped.
     */
    readonly adoptsRunningService?: (ownerId: string, applicationId: string) => Promise<boolean>;

    /** Fold older install rows into the app's own, when a screen that lists
     *  installs is opened. */
    readonly adopt?: (ownerId: string) => Promise<unknown>;

    /** The titles of the events among these ids that this account may read,
     *  for a pasted calendar link to show as a named chip. */
    readonly eventTitles?: (
        userId: string,
        ids: readonly string[]
    ) => Promise<Readonly<Record<string, string>>>;

    /** The reader's next events, for the Overview card, soonest first. */
    readonly upcomingEvents?: (userId: string, limit: number) => Promise<readonly UpcomingEvent[]>;

    /** Its servers, for the overview card. */
    readonly gameServerSummaries?: (userId: string) => Promise<readonly GameServerSummary[]>;

    /**
     * The tools it offers connected assistants over MCP. Listed, callable and
     * offered as scopes only while the app is installed; each tool names a
     * scope from core's table (`lib/mcp/scope-table.ts`) and enforces access
     * with the app's own rules. Loaded when asked, so the tools' modules are
     * not imported with the registry. See docs/installable-apps-plan.md.
     */
    readonly mcpTools?: () => Promise<readonly AppMcpTool[]>;

    /**
     * How `polaris_search` finds its things: one provider per kind of thing,
     * each naming the scope it needs and enforcing the app's own reach, built
     * with `host.mcp.defineSearch`. Asked only while the app is installed,
     * like its tools. See `lib/mcp/search.ts`.
     */
    readonly mcpSearch?: () => Promise<readonly AppMcpSearchProvider[]>;

    /** The ports the router has to forward for it. */
    readonly forwardedPorts?: () => Promise<readonly GamePortRow[]>;

    /** The cards it offers for the Overview - see `AppWidgetDefinition`. */
    readonly overviewWidgets?: () => readonly AppWidgetDefinition[];

    /** The same, with the advice the Domains card shows, knocking when asked. */
    readonly readForwardedPorts?: (probe: boolean) => Promise<GamePortsReading>;

    /** What the firewall shows above the web rules for a service it runs. */
    readonly firewallSlot?: (ownerId: string, applicationId: string) => Promise<AppSlot | null>;

    /**
     * What it draws in the header of every screen, beside the bell - Calendar's
     * running timers, say. Asked once per page frame, so it must not read
     * anything: the component it names reads its own data in the browser, and
     * draws nothing while there is nothing to show.
     */
    readonly headerSlot?: () => AppSlot | null;

    /** The panel an installed-app page draws for one of its installs. */
    readonly installedPanelSlot?: (install: ExtensionInstall) => Promise<AppSlot | null>;

    /** Work started once when the dashboard boots. Must not wait on anything:
     *  the server is still starting. */
    readonly onBoot?: () => void;

    /** Whether this account reaches the app without holding its permission -
     *  somebody lent one item of it. */
    readonly reaches?: (userId: string) => Promise<boolean>;

    /** An invite that carried a link to one of its things was claimed. The
     *  inviter has already been re-checked; an app that does not know the kind
     *  leaves it. */
    readonly claimLink?: (claim: {
        readonly userId: string;
        readonly installedAppId: string;
        readonly grantedById: string;
        readonly link: PendingAppLink;
    }) => Promise<void>;

    /**
     * Show one Chat message to one account inside whatever this app runs that
     * the account is playing on right now, where only they see it. Called only
     * for an account that turned it on and that the message would have
     * interrupted anyway - see `chat/game-relay`. Nothing to do is not a
     * failure: most of the time nobody is playing.
     */
    readonly relayChatMessage?: (message: RelayedChatMessage) => Promise<void>;

    /** Whether a message could reach this account in the game at all: the app
     *  knows which of its players is them. Until it does, the setting that
     *  chooses which messages go there is not offered. */
    readonly chatRelayReady?: (userId: string) => Promise<boolean>;

    /**
     * Which of these accounts are playing on one of this app's servers right
     * now, by the app's own record of who is on and its own rule for which
     * player is which account. Asked for a page of faces at a time, so it must
     * be one or two indexed reads rather than a question to any server.
     */
    readonly playingNow?: (userIds: readonly string[]) => Promise<readonly PlayingNow[]>;

    /**
     * Which of these Chat conversations one of its things is linked to - a game
     * server whose operator chose the group or the channels it talks through.
     * Chat draws a badge on each, and offers the commands it lists.
     */
    readonly chatGameLinks?: (channelIds: readonly string[]) => Promise<readonly ChatGameLink[]>;

    /**
     * The answers to a command somebody wrote in a conversation (`/online`,
     * without the slash). Empty when it is not one of its commands, or not a
     * conversation it is linked to. The writer is already a member: Chat let
     * them write there.
     */
    readonly answerChatCommand?: (input: {
        readonly channelId: string;
        readonly command: string;
    }) => Promise<readonly string[]>;

    /**
     * A message said in a conversation, whatever anybody's own settings, for an
     * app that shows a linked channel to everybody inside what it runs. Nothing
     * to do is not a failure: most channels are linked to nothing.
     */
    readonly relayChannelMessage?: (message: RelayedChannelMessage) => Promise<void>;

    /**
     * The bans, timeouts and kicks its servers put on the players linked to this
     * account, for its Account standing page: those in force, and recent ones.
     * They are the servers' decisions, not Polaris's, and are drawn apart.
     */
    readonly gameSanctions?: (userId: string) => Promise<readonly GameSanction[]>;
}

/** A tool an app offers over MCP, its input type already erased by
 *  `defineTool` (`host.mcp.defineTool`). */
export type AppMcpTool = McpTool<never>;

/** A search provider an app offers `polaris_search`. */
export type AppMcpSearchProvider = McpSearchProvider;

/** A sanction a game server put on a player linked to an account. */
export interface GameSanction {
    readonly id: string;
    readonly kind: "ban" | "timeout" | "kick";
    /** The game, as people call it: "Minecraft". */
    readonly game: string;
    /** The server, as its owner named it. */
    readonly server: string;
    /** The player it was put on. */
    readonly player: string;
    readonly at: Date;
    /** When a timeout lifts by itself; null for a ban or a kick. */
    readonly until: Date | null;
    /** Whether it still keeps them out. */
    readonly active: boolean;
    readonly reason: string | null;
}

/** A command an app answers in a conversation linked to it. */
export interface ChatCommandSpec {
    /** What is typed after the slash. */
    readonly name: string;
    /** One line, for the list the composer shows. */
    readonly description: string;
}

/** One Chat conversation an app's thing is linked to. */
export interface ChatGameLink {
    readonly channelId: string;
    readonly installedAppId: string;
    /** Whose shelf the thing is on, for deciding who may open it. */
    readonly ownerId: string;
    /** What its page calls it. */
    readonly name: string;
    /** The game it runs, by name ("Minecraft"). */
    readonly game: string;
    /** The game's mark, served from `public/logos`. */
    readonly logo: string;
    /** The commands it answers here. Empty where it only feeds the call. */
    readonly commands: readonly ChatCommandSpec[];
}

/** One message said in a conversation, on its way to everybody in a game. */
export interface RelayedChannelMessage {
    readonly channelId: string;
    /** Who wrote it, named by the app only once it has somewhere to show it. */
    readonly authorId: string;
    /** What the conversation is called. */
    readonly conversation: string;
    readonly text: string;
    readonly files: string | null;
    readonly poll: readonly string[] | null;
    readonly forwarded: boolean;
}

/** Somebody on one of an app's servers, as their presence card says it. */
export interface PlayingNow {
    readonly userId: string;
    /** The game, as people call it: "Minecraft". */
    readonly game: string;
    /** The server, as its owner named it. */
    readonly server: string;
    /** When this visit started. */
    readonly since: Date;
    /** The installed server, for its picture. */
    readonly installedAppId?: string;
    /** The game catalog's id (`minecraft`), for its mark. */
    readonly gameId?: string;
    /** Where the server's own picture is served from, when it can have one. */
    readonly imageUrl?: string | null;
}

/** One Chat message on its way into a game, already decided to be wanted. */
export interface RelayedChatMessage {
    /** Whose screen it goes to. */
    readonly userId: string;
    readonly author: string;
    /** What the conversation is called from the reader's side. */
    readonly conversation: string;
    /** Whether it is a channel rather than a direct message or a group. */
    readonly inChannel: boolean;
    /** The words, plain - a poll's question - or empty when there are none. */
    readonly text: string;
    /** What files it carries, as a label ("Photo", "3 files", a file's name),
     *  or null for none. */
    readonly files: string | null;
    /** A poll's answers, in order, or null when it is not a poll. */
    readonly poll: readonly string[] | null;
    /** Whether it was forwarded from another conversation. */
    readonly forwarded: boolean;
    /** The conversation it was said in. */
    readonly channelId: string;
}

/* -------------------------------------------------------------------------- */
/* Overview cards                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A card an installed app offers for the Overview.
 *
 * Generic on purpose: an app says what to show and what can be pressed, as
 * data, and the dashboard draws it with its own components - so any app can
 * add a card without shipping a component of its own, and every card looks like
 * every other one. What a card watches is a list of the app's own ids that the
 * reader picked (`targets`); everything shown about them, and whether the reader
 * may still see or operate each one, is the app's to answer on every read and
 * every press - the stored list is a preference, never a grant.
 *
 * Every function runs inside the reader's request, so an app checks the session
 * the way its own screens and actions do.
 */
export interface AppWidgetDefinition {
    /** Unique within the app, and stable: it is stored in layouts. */
    readonly kind: string;
    /** How wide it starts. */
    readonly defaultSize: "sm" | "md" | "lg" | "xl";
    /** The name and one line about it, in the reader's language. */
    readonly describe: () => Promise<{ readonly label: string; readonly hint: string }>;
    /** What the reader may pick for it, or an empty list when there is nothing
     *  to pick (or they may see none of it). */
    readonly targets: () => Promise<readonly AppWidgetTarget[]>;
    /** What to draw for these targets. Ids the reader may no longer see are
     *  left out rather than reported. */
    readonly read: (targets: readonly string[]) => Promise<AppWidgetView>;
    /** Press one of the controls `read` drew. Refused in a sentence, through
     *  the same checks the app's own screens use. */
    readonly act?: (
        targets: readonly string[],
        input: AppWidgetInput
    ) => Promise<{ readonly error?: string }>;
}

/** Something a card can watch, as the picker lists it. */
export interface AppWidgetTarget {
    readonly id: string;
    readonly label: string;
    /** Where it is, or what it is - the second line of the picker. */
    readonly detail?: string;
}

/** One figure about one target. */
export interface AppWidgetReading {
    readonly label: string;
    readonly value: string;
    readonly tone?: "ok" | "warn" | "bad";
}

/** Something a card lets the reader change about one target. `disabled` is the
 *  reason it cannot be changed right now, said where the control is. */
export type AppWidgetControl =
    | {
          readonly kind: "toggle";
          readonly id: string;
          readonly label: string;
          readonly on: boolean;
          readonly disabled?: string | null;
      }
    | {
          readonly kind: "number";
          readonly id: string;
          readonly label: string;
          readonly value: number | null;
          readonly min: number;
          readonly max: number;
          readonly step: number;
          readonly unit: string;
          readonly disabled?: string | null;
      };

/** One target as a card draws it. */
export interface AppWidgetItem {
    readonly id: string;
    readonly title: string;
    readonly subtitle?: string;
    /** Its state in a word ("On", "Cooling"), with how it should read. */
    readonly state?: string;
    readonly tone?: "ok" | "warn" | "bad" | "off";
    readonly readings: readonly AppWidgetReading[];
    readonly controls: readonly AppWidgetControl[];
    /** Where its own screen is. */
    readonly href?: string;
}

export interface AppWidgetView {
    readonly items: readonly AppWidgetItem[];
}

/** One press on a card. Validated by the dashboard before an app sees it. */
export interface AppWidgetInput {
    readonly item: string;
    readonly control: string;
    readonly value: boolean | number;
}
