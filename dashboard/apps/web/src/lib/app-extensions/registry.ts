/**
 * Core's one way to reach an installable app.
 *
 * Each question is asked of every installed extension and answered by the ones
 * that have something to say. The list is read when a question is asked rather
 * than when this module loads, so an app module that itself imports core does
 * not trip over a half-loaded cycle.
 *
 * Server-only.
 */

import type { ServerNode as AutomationServerNode } from "@/lib/automations/types";
import { withBundleSlot } from "@/lib/app-bundles/code";
import { installedExtensions } from "./installed";
import type { BusyEvent, Locale } from "@polaris/core";
import { isAppInstalled } from "@/lib/apps/install-presence";
import type { BackupSource } from "@/lib/backups/sources/types";
import type { GamePortRow, GamePortsReading } from "@/lib/apps/port-advice";
import type {
    AppAutomationsFilter,
    AppDeckAction,
    AppExtension,
    AppFavorite,
    AppJob,
    AppMcpTool,
    AppMcpSearchProvider,
    AppRecordHit,
    AppSlot,
    AppWidgetDefinition,
    ConnectionsViewer,
    ChatCommandSpec,
    ChatGameLink,
    ExtensionInstall,
    LegacyRunRow,
    GameSanction,
    GameServerSummary,
    PlayingNow,
    RelayedChannelMessage,
    RelayedChatMessage,
    UpcomingEvent
} from "./types";

export type {
    AppAutomationsFilter,
    AppExtension,
    AppJob,
    AppMcpTool,
    AppMcpSearchProvider,
    AppRecordHit,
    AppSlot,
    ChatCommandSpec,
    ChatGameLink,
    ExtensionInstall,
    GameSanction,
    GameServerSummary,
    PlayingNow,
    RelayedChannelMessage,
    RelayedChatMessage,
    UpcomingEvent
};

function extensions(): readonly AppExtension[] {
    return installedExtensions();
}

/**
 * A job that only runs while its app is installed.
 *
 * Without the app there is nothing it should be doing, and an uninstalled app
 * must not keep reaching into containers or cameras on its own.
 */
export function whileInstalled(
    catalogId: string,
    run: () => Promise<unknown>
): () => Promise<unknown> {
    return async () => {
        if (!(await isAppInstalled(catalogId))) return { skipped: `${catalogId} is not installed` };
        return run();
    };
}

/** Every app's scheduled jobs, each running only while its app is installed. */
/**
 * The automation node types the installed apps contribute. An app that is not
 * installed contributes none, so a run that reaches one of its nodes is refused.
 */
export async function appAutomationNodes(): Promise<AutomationServerNode[]> {
    const lists = await Promise.all(
        extensions().map(async (extension) => {
            if (!extension.automationNodes || !(await isAppInstalled(extension.id))) return [];
            return extension.automationNodes().catch(() => []);
        })
    );
    return lists.flat();
}

/**
 * Where each installed app that brings automation nodes draws their settings:
 * its slot of kind `automation-node`, by app id. An app that is not installed is
 * absent, which the editor shows as a node that needs it.
 */
export async function appAutomationNodeSlots(): Promise<Record<string, AppSlot>> {
    const found = await Promise.all(
        extensions().map(async (extension) => {
            if (!extension.automationNodes || !(await isAppInstalled(extension.id))) return null;
            const slot: AppSlot = { app: extension.id, kind: "automation-node", props: null };
            return [extension.id, withBundleSlot(slot)] as const;
        })
    );
    return Object.fromEntries(found.filter((entry) => entry !== null));
}

/** The runs a moved automation had in its app, before the move; none while the app is away. */
export async function appAutomationHistory(
    app: string,
    legacyRef: string
): Promise<LegacyRunRow[]> {
    const extension = extensions().find((entry) => entry.id === app);
    if (!extension?.automationHistory || !(await isAppInstalled(app))) return [];
    return [...(await extension.automationHistory(legacyRef))];
}

/**
 * What the automations list filtered to one app shows of that app: its name,
 * the name of the thing `ref` names, and its slots. Null when the app is not
 * installed, brings no filter, or has nothing of its own for this viewer.
 */
export async function appAutomationsFilter(
    app: string,
    ref: string | null
): Promise<AppAutomationsFilter | null> {
    const extension = extensions().find((entry) => entry.id === app);
    if (!extension?.automationsFilter || !(await isAppInstalled(app))) return null;
    const found = await extension.automationsFilter(ref).catch((error: unknown) => {
        console.error(`polaris: ${app} could not describe its automations filter:`, error);
        return null;
    });
    if (!found) return null;
    return {
        ...found,
        actions: found.actions ? withBundleSlot(found.actions) : null,
        after: found.after ? withBundleSlot(found.after) : null
    };
}

export function appJobs(): AppJob[] {
    return extensions().flatMap((extension) =>
        (extension.jobs?.() ?? []).map((job) => ({
            ...job,
            run: whileInstalled(extension.id, job.run)
        }))
    );
}

/** The backup source an app provides for a resource kind, if one does. */
export function appBackupSource(kind: BackupSource["kind"]): BackupSource | null {
    for (const extension of extensions()) {
        const source = extension.backupSources?.()[kind];
        if (source) return source;
    }
    return null;
}

/** Every backup source the apps provide. */
export function appBackupSources(): BackupSource[] {
    return extensions().flatMap((extension) =>
        Object.values(extension.backupSources?.() ?? {}).filter((source): source is BackupSource =>
            Boolean(source)
        )
    );
}

/** The image an app decides a release runs, or the stored one. */
export function releaseImageFor(
    storedImage: string | undefined,
    env: Readonly<Record<string, string>>
): string | undefined {
    for (const extension of extensions()) {
        const image = extension.releaseImage?.(storedImage, env);
        if (image !== undefined && image !== storedImage) return image;
    }
    return storedImage;
}

/** The environment apps lay over a release that runs this image, every deploy.
 *  Empty when no app has an opinion about it. */
export function releaseEnvFor(imageRef: string | undefined): Record<string, string> {
    return Object.assign(
        {},
        ...extensions().map((extension) => extension.releaseEnv?.(imageRef) ?? {})
    );
}

/** Whether an install's settings describe a server that loads plugins. Null when
 *  no app knows the catalog app. */
export function isPluginServer(
    catalogId: string,
    env: ReadonlyMap<string, string>
): boolean | null {
    for (const extension of extensions()) {
        const answer = extension.pluginServer?.(catalogId, env);
        if (answer !== null && answer !== undefined) return answer;
    }
    return null;
}

/** Let every app write out what only lives in memory before an install stops. */
export async function beforeInstallStops(ownerId: string, installedAppId: string): Promise<void> {
    for (const extension of extensions()) await extension.beforeStop?.(ownerId, installedAppId);
}

/** Some of an install's files are still where they were, so the rows that find
 *  them must not be purged yet. */
export class InstallFilesLeftError extends Error {
    public constructor(public readonly extensionIds: readonly string[]) {
        super(`Files of this install are still left by ${extensionIds.join(", ")}`);
        this.name = "InstallFilesLeftError";
    }
}

/** Let every app remove the files an install wrote before its rows are purged.
 *  One app failing does not keep the others from removing theirs, but it is
 *  reported once they all ran, with `InstallFilesLeftError`. */
export async function purgeInstallFiles(installedAppId: string): Promise<void> {
    const failed: string[] = [];
    for (const extension of extensions()) {
        await extension.purgeInstallFiles?.(installedAppId).catch((caught) => {
            console.error(`polaris: ${extension.id} could not remove an install's files:`, caught);
            failed.push(extension.id);
        });
    }
    if (failed.length > 0) throw new InstallFilesLeftError(failed);
}

/** Tell every app an install was started by hand. */
export async function afterInstallStarts(installedAppId: string): Promise<void> {
    for (const extension of extensions()) await extension.afterStart?.(installedAppId);
}

/** Whether an app takes a service recorded as stopped, found running, as running
 *  again. An app that fails to answer is a no. */
export async function adoptsRunningService(
    ownerId: string,
    applicationId: string
): Promise<boolean> {
    for (const extension of extensions()) {
        const adopted = await extension
            .adoptsRunningService?.(ownerId, applicationId)
            .catch(() => false);
        if (adopted) return true;
    }
    return false;
}

/** Hand a claimed invite's link to the app it belongs to. One app failing does
 *  not stop another, and none of them can fail the account being created. */
export async function claimAppLink(
    claim: Parameters<NonNullable<AppExtension["claimLink"]>>[0]
): Promise<void> {
    for (const extension of extensions()) {
        await extension.claimLink?.(claim).catch((caught: unknown) => {
            console.error("polaris: an invite's link could not be applied:", caught);
        });
    }
}

/** Let every app fold its older install rows into its own. */
export async function adoptAppInstalls(ownerId: string): Promise<void> {
    await Promise.all(extensions().map((extension) => extension.adopt?.(ownerId)));
}

/** The titles of the calendar events this account may read, by id. Empty when
 *  no installed app keeps calendars, or when it could not answer. */
export async function eventTitlesFor(
    userId: string,
    ids: readonly string[]
): Promise<Record<string, string>> {
    for (const extension of await installedWith("eventTitles")) {
        return { ...(await extension.eventTitles!(userId, ids).catch(() => ({}))) };
    }
    return {};
}

/** This account's next events, from the app that keeps calendars, or null when
 *  no installed app does. */
export async function upcomingEventsFor(
    userId: string,
    limit: number
): Promise<UpcomingEvent[] | null> {
    for (const extension of await installedWith("upcomingEvents")) {
        return [...(await extension.upcomingEvents!(userId, limit))];
    }
    return null;
}

/** The busy events reaching a window for these people, from the app that
 *  keeps calendars, or null when no installed app does. */
export async function presenceBusyFor(
    asks: readonly { userId: string; calendarIds: readonly string[] | null; zone: string }[],
    window: { from: Date; to: Date }
): Promise<ReadonlyMap<string, readonly BusyEvent[]> | null> {
    for (const extension of await installedWith("presenceBusy")) {
        return extension.presenceBusy!(asks, window);
    }
    return null;
}

/** The calendars this account may pick for automatic status, or null when no
 *  installed app keeps calendars. */
export async function presenceCalendarsFor(
    userId: string
): Promise<{ id: string; name: string; color: string }[] | null> {
    for (const extension of await installedWith("presenceCalendars")) {
        return [...(await extension.presenceCalendars!(userId))];
    }
    return null;
}

/** What this account pinned inside one installed app, or none. An app that
 *  fails to say leaves the rail without them, never broken. */
export async function appFavorites(appId: string, userId: string): Promise<AppFavorite[]> {
    const extension = (await installedWith("favorites")).find((one) => one.id === appId);
    if (!extension) return [];
    try {
        return [...(await extension.favorites!(userId))];
    } catch (caught) {
        console.error(`polaris: ${appId} could not list its favorites:`, caught);
        return [];
    }
}

/** The records the installed apps found for this account, at most `limit`. One
 *  app failing leaves the others' answers standing. */
export async function appRecordHits(
    userId: string,
    query: string,
    limit: number
): Promise<AppRecordHit[]> {
    const lists = await Promise.all(
        (await installedWith("searchRecords")).map(async (extension) => {
            try {
                return [...(await extension.searchRecords!(userId, query, limit))];
            } catch (caught) {
                console.error(`polaris: ${extension.id} could not search its records:`, caught);
                return [];
            }
        })
    );
    return lists.flat().slice(0, limit);
}

/** Every game server this account can see, for the overview. */
export async function gameServerSummaries(userId: string): Promise<GameServerSummary[]> {
    const lists = await Promise.all(
        extensions().map((extension) => extension.gameServerSummaries?.(userId) ?? [])
    );
    return lists.flat();
}

/** Every card the installed apps offer for the Overview, with the app it is
 *  from. An app that is not installed offers none. */
export async function appWidgetDefinitions(): Promise<
    { readonly app: string; readonly definition: AppWidgetDefinition }[]
> {
    return (await installedWith("overviewWidgets")).flatMap((extension) =>
        (extension.overviewWidgets?.() ?? []).map((definition) => ({
            app: extension.id,
            definition
        }))
    );
}

/** Every port a router has to forward for the installed apps. */
export async function forwardedPorts(): Promise<GamePortRow[]> {
    const lists = await Promise.all(
        extensions().map((extension) => extension.forwardedPorts?.() ?? [])
    );
    return lists.flat();
}

/** The Domains card's reading, from the app that forwards ports. Null when none
 *  is installed. */
export async function readForwardedPorts(probe: boolean): Promise<GamePortsReading | null> {
    for (const extension of extensions()) {
        if (extension.readForwardedPorts) return extension.readForwardedPorts(probe);
    }
    return null;
}

/** What an app shows on the firewall for a service it runs. */
export async function firewallSlot(
    ownerId: string,
    applicationId: string
): Promise<AppSlot | null> {
    for (const extension of extensions()) {
        const slot = await extension.firewallSlot?.(ownerId, applicationId);
        if (slot) return withBundleSlot(slot);
    }
    return null;
}

/** Start what each app runs from boot. */
export function bootApps(): void {
    for (const extension of extensions()) {
        try {
            extension.onBoot?.();
        } catch (error) {
            console.error(`polaris: ${extension.id} could not start:`, error);
        }
    }
}

/** The installed apps that can show a Chat message inside a game. */
async function chatRelays(): Promise<AppExtension[]> {
    const offering = extensions().filter((extension) => extension.relayChatMessage);
    const installed = await Promise.all(offering.map((extension) => isAppInstalled(extension.id)));
    return offering.filter((_, index) => installed[index]);
}

/** Whether any installed app can show Chat messages inside a game, which is
 *  whether the setting that turns it on is worth offering. */
export async function relaysChatToGames(): Promise<boolean> {
    return (await chatRelays()).length > 0;
}

/** Whether any installed app could show this account a Chat message in a game:
 *  it knows which of its players they are. */
export async function chatRelayReady(userId: string): Promise<boolean> {
    for (const extension of await chatRelays()) {
        const ready = await extension.chatRelayReady?.(userId).catch(() => false);
        if (ready) return true;
    }
    return false;
}

/**
 * The accounts any installed app could show a Chat message to in a game right
 * now, or null when one of them cannot say (an older version of it), and then
 * the caller has to look wider. An app that fails to answer counts as unable.
 */
export async function chatRelayAccounts(): Promise<Set<string> | null> {
    const accounts = new Set<string>();
    for (const extension of await chatRelays()) {
        if (!extension.chatRelayAccounts) return null;
        const playing = await extension.chatRelayAccounts().catch(() => null);
        if (!playing) return null;
        for (const userId of playing) accounts.add(userId);
    }
    return accounts;
}

/** What hands one message to every app that can show it in a game, resolved
 *  once however many readers it goes to, or null when no installed app can. One
 *  app failing does not stop another, and none of them can fail the message. */
export async function chatRelayer(): Promise<
    ((message: RelayedChatMessage) => Promise<void>) | null
> {
    const relays = await chatRelays();
    if (relays.length === 0) return null;
    return async (message) => {
        for (const extension of relays) {
            await extension.relayChatMessage?.(message).catch((caught: unknown) => {
                console.error("polaris: a message could not be shown in a game:", caught);
            });
        }
    };
}

/**
 * Who of these accounts is playing on a server an installed app runs, one visit
 * each - the earliest, when somebody is somehow on two at once.
 *
 * One app failing is that app saying nothing, never the presence around it
 * failing: this is asked on every refresh of every face on a screen.
 */
export async function playingNowFor(userIds: readonly string[]): Promise<Map<string, PlayingNow>> {
    const found = new Map<string, PlayingNow>();
    if (userIds.length === 0) return found;
    const offering = extensions().filter((extension) => extension.playingNow);
    for (const extension of offering) {
        if (!(await isAppInstalled(extension.id).catch(() => false))) continue;
        const playing = await extension.playingNow!(userIds).catch((caught: unknown) => {
            console.error(`polaris: ${extension.id} could not say who is playing:`, caught);
            return [];
        });
        for (const visit of playing) {
            const held = found.get(visit.userId);
            if (!held || visit.since < held.since) found.set(visit.userId, visit);
        }
    }
    return found;
}

/** The installed apps that have a say about this hook. */
async function installedWith(hook: keyof AppExtension): Promise<AppExtension[]> {
    const offering = extensions().filter((extension) => extension[hook]);
    const installed = await Promise.all(offering.map((extension) => isAppInstalled(extension.id)));
    return offering.filter((_, index) => installed[index]);
}

/**
 * The MCP tools the installed apps offer, each with the app it came from.
 *
 * Asked on every call rather than kept: an app uninstalled a moment ago must
 * stop answering at once, and what is installed is already cached for a few
 * seconds by `isAppInstalled`. One app failing to say leaves its tools out and
 * never anybody else's.
 */
export async function appMcpTools(): Promise<{ app: string; tool: AppMcpTool }[]> {
    const lists = await Promise.all(
        (await installedWith("mcpTools")).map(async (extension) => {
            try {
                const tools = (await extension.mcpTools?.()) ?? [];
                return tools.map((tool) => ({ app: extension.id, tool }));
            } catch (caught) {
                console.error(`polaris: ${extension.id} could not list its MCP tools:`, caught);
                return [];
            }
        })
    );
    return lists.flat();
}

/**
 * The keys and dials the installed apps offer a Stream Deck. Asked on every
 * call, like the tools they are bound to; one app failing to say leaves its
 * actions out and never anybody else's.
 */
export async function appDeckActions(): Promise<AppDeckAction[]> {
    const lists = await Promise.all(
        (await installedWith("deckActions")).map(async (extension) => {
            try {
                return [...((await extension.deckActions?.()) ?? [])];
            } catch (caught) {
                console.error(`polaris: ${extension.id} could not list its deck actions:`, caught);
                return [];
            }
        })
    );
    return lists.flat();
}

/**
 * What a person reads for each installed app's MCP tools, by tool name, in
 * their language. One app failing to say leaves its tools to their English
 * titles and never anybody else's.
 */
export async function appMcpToolLabels(locale: Locale): Promise<Map<string, string>> {
    const labels = new Map<string, string>();
    for (const extension of await installedWith("mcpToolLabels")) {
        try {
            const own = await extension.mcpToolLabels!(locale);
            for (const [name, label] of Object.entries(own)) labels.set(name, label);
        } catch (caught) {
            console.error(`polaris: ${extension.id} could not name its MCP tools:`, caught);
        }
    }
    return labels;
}

/**
 * The search providers the installed apps offer `polaris_search`, each with
 * the app it came from. Asked on every call, as the tools are; one app
 * failing to say leaves its providers out and never anybody else's.
 */
export async function appMcpSearchProviders(): Promise<
    { app: string; provider: AppMcpSearchProvider }[]
> {
    const lists = await Promise.all(
        (await installedWith("mcpSearch")).map(async (extension) => {
            try {
                const providers = (await extension.mcpSearch?.()) ?? [];
                return providers.map((provider) => ({ app: extension.id, provider }));
            } catch (caught) {
                console.error(`polaris: ${extension.id} could not list its search:`, caught);
                return [];
            }
        })
    );
    return lists.flat();
}

/** What the installed apps have linked to these Chat conversations. One app
 *  failing leaves the others' badges, and never the conversations, standing. */
export async function chatGameLinks(channelIds: readonly string[]): Promise<ChatGameLink[]> {
    if (channelIds.length === 0) return [];
    const lists = await Promise.all(
        (await installedWith("chatGameLinks")).map((extension) =>
            (extension.chatGameLinks?.(channelIds) ?? Promise.resolve([])).catch(
                (caught: unknown) => {
                    console.error(`polaris: ${extension.id} could not say what it links:`, caught);
                    return [] as readonly ChatGameLink[];
                }
            )
        )
    );
    return lists.flat();
}

/** Every installed app's answers to a command written in a conversation. */
export async function answerChatCommand(input: {
    readonly channelId: string;
    readonly command: string;
}): Promise<string[]> {
    const answers: string[] = [];
    for (const extension of await installedWith("answerChatCommand")) {
        const said = await extension.answerChatCommand?.(input).catch((caught: unknown) => {
            console.error(`polaris: ${extension.id} could not answer a command:`, caught);
            return [] as readonly string[];
        });
        answers.push(...(said ?? []));
    }
    return answers;
}

/** What hands a channel's message to every app that shows linked channels to
 *  everybody in a game, or null when no installed app can. Never fails. */
export async function channelRelayer(): Promise<
    ((message: RelayedChannelMessage) => Promise<void>) | null
> {
    const relays = await installedWith("relayChannelMessage");
    if (relays.length === 0) return null;
    return async (message) => {
        for (const extension of relays) {
            await extension.relayChannelMessage?.(message).catch((caught: unknown) => {
                console.error("polaris: a channel message could not be shown in a game:", caught);
            });
        }
    };
}

/** Whether this account reaches an app it holds no permission for. */
export async function appReaches(appId: string, userId: string): Promise<boolean> {
    const extension = extensions().find((entry) => entry.id === appId);
    return extension?.reaches ? extension.reaches(userId) : false;
}

/**
 * What the installed apps add to a connections hub, in registry order. One
 * app failing to answer leaves its section out and never anybody else's.
 */
export async function connectionsSlots(viewer: ConnectionsViewer): Promise<AppSlot[]> {
    const offering = await installedWith("connectionsSlot");
    const answers = await Promise.all(
        offering.map((extension) =>
            (extension.connectionsSlot?.(viewer) ?? Promise.resolve(null)).catch(
                (caught: unknown) => {
                    console.error(
                        `polaris: ${extension.id} could not draw its connections:`,
                        caught
                    );
                    return null;
                }
            )
        )
    );
    return answers.filter((slot): slot is AppSlot => slot !== null).map(withBundleSlot);
}

/** The panel an app draws on one of its installs' pages. */
export async function installedPanelSlot(install: ExtensionInstall): Promise<AppSlot | null> {
    // Every app is asked at once rather than in turn, so the page waits for the
    // slowest answer instead of the sum of them. The first in order still wins,
    // and a failure still fails the call only if it comes before the winner: the
    // ones after it are left to settle on their own.
    const asked = extensions().map((extension) => extension.installedPanelSlot?.(install) ?? null);
    for (const pending of asked) void pending?.catch(() => undefined);
    for (const pending of asked) {
        const slot = await pending;
        if (slot) return withBundleSlot(slot);
    }
    return null;
}

/**
 * What the apps this person reaches draw in every screen's header. `appIds` are
 * the apps the frame already resolved for them - installed, and allowed - so
 * this asks nothing of the database.
 */
export function headerSlots(appIds: readonly string[]): AppSlot[] {
    const slots: AppSlot[] = [];
    for (const extension of extensions()) {
        if (!extension.headerSlot || !appIds.includes(extension.id)) continue;
        try {
            const slot = extension.headerSlot();
            if (slot) slots.push(withBundleSlot(slot));
        } catch (caught) {
            console.error(
                `polaris: ${extension.id} could not say what it draws in the header:`,
                caught
            );
        }
    }
    return slots;
}

/** Whether any installed app keeps sanctions its servers put on players, which
 *  is whether Account standing has a section for them at all. */
export async function offersGameSanctions(): Promise<boolean> {
    return (await installedWith("gameSanctions")).length > 0;
}

/**
 * The sanctions the installed apps' servers put on the players linked to this
 * account. `incomplete` when an app could not answer, so the page says so
 * instead of reading as a clean record.
 */
export async function gameSanctionsFor(
    userId: string
): Promise<{ sanctions: GameSanction[]; incomplete: boolean }> {
    let incomplete = false;
    const lists = await Promise.all(
        (await installedWith("gameSanctions")).map((extension) =>
            (extension.gameSanctions?.(userId) ?? Promise.resolve([])).catch((caught: unknown) => {
                console.error(`polaris: ${extension.id} could not list game sanctions:`, caught);
                incomplete = true;
                return [] as readonly GameSanction[];
            })
        )
    );
    const sanctions = lists
        .flat()
        .sort(
            (left, right) =>
                Number(right.active) - Number(left.active) || right.at.getTime() - left.at.getTime()
        );
    return { sanctions, incomplete };
}
