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

import { withBundleSlot } from "@/lib/app-bundles/code";
import { installedExtensions } from "./installed";
import { isAppInstalled } from "@/lib/apps/install-presence";
import type { BackupSource } from "@/lib/backups/sources/types";
import type { GamePortRow, GamePortsReading } from "@/lib/apps/port-advice";
import type {
    AppExtension,
    AppJob,
    AppSlot,
    ChatCommandSpec,
    ChatGameLink,
    ExtensionInstall,
    GameServerSummary,
    PlayingNow,
    RelayedChannelMessage,
    RelayedChatMessage
} from "./types";

export type {
    AppExtension,
    AppJob,
    AppSlot,
    ChatCommandSpec,
    ChatGameLink,
    ExtensionInstall,
    GameServerSummary,
    PlayingNow,
    RelayedChannelMessage,
    RelayedChatMessage
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

/** Tell every app an install was started by hand. */
export async function afterInstallStarts(installedAppId: string): Promise<void> {
    for (const extension of extensions()) await extension.afterStart?.(installedAppId);
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

/** Every game server this account can see, for the overview. */
export async function gameServerSummaries(userId: string): Promise<GameServerSummary[]> {
    const lists = await Promise.all(
        extensions().map((extension) => extension.gameServerSummaries?.(userId) ?? [])
    );
    return lists.flat();
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

/** The panel an app draws on one of its installs' pages. */
export async function installedPanelSlot(install: ExtensionInstall): Promise<AppSlot | null> {
    for (const extension of extensions()) {
        const slot = await extension.installedPanelSlot?.(install);
        if (slot) return withBundleSlot(slot);
    }
    return null;
}
