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

import { installedExtensions } from "./installed";
import { isAppInstalled } from "@/lib/apps/install-presence";
import type { BackupSource } from "@/lib/backups/sources/types";
import type { GamePortRow, GamePortsReading } from "@/lib/apps/port-advice";
import type { AppExtension, AppJob, AppSlot, ExtensionInstall, GameServerSummary } from "./types";

export type { AppExtension, AppJob, AppSlot, ExtensionInstall, GameServerSummary };

function extensions(): readonly AppExtension[] {
    return installedExtensions();
}

/**
 * A job that only runs while its app is installed.
 *
 * Without the app there is nothing it should be doing, and an uninstalled app
 * must not keep reaching into containers or cameras on its own.
 */
export function whileInstalled(catalogId: string, run: () => Promise<unknown>): () => Promise<unknown> {
    return async () => {
        if (!(await isAppInstalled(catalogId))) return { skipped: `${catalogId} is not installed` };
        return run();
    };
}

/** Every app's scheduled jobs, each running only while its app is installed. */
export function appJobs(): AppJob[] {
    return extensions().flatMap((extension) =>
        (extension.jobs?.() ?? []).map((job) => ({ ...job, run: whileInstalled(extension.id, job.run) }))
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
        Object.values(extension.backupSources?.() ?? {}).filter((source): source is BackupSource => Boolean(source))
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
export function isPluginServer(catalogId: string, env: ReadonlyMap<string, string>): boolean | null {
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

/** Let every app fold its older install rows into its own. */
export async function adoptAppInstalls(ownerId: string): Promise<void> {
    await Promise.all(extensions().map((extension) => extension.adopt?.(ownerId)));
}

/** Every game server this account can see, for the overview. */
export async function gameServerSummaries(userId: string): Promise<GameServerSummary[]> {
    const lists = await Promise.all(extensions().map((extension) => extension.gameServerSummaries?.(userId) ?? []));
    return lists.flat();
}

/** Every port a router has to forward for the installed apps. */
export async function forwardedPorts(): Promise<GamePortRow[]> {
    const lists = await Promise.all(extensions().map((extension) => extension.forwardedPorts?.() ?? []));
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
export async function firewallSlot(ownerId: string, applicationId: string): Promise<AppSlot | null> {
    for (const extension of extensions()) {
        const slot = await extension.firewallSlot?.(ownerId, applicationId);
        if (slot) return slot;
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

/** Whether this account reaches an app it holds no permission for. */
export async function appReaches(appId: string, userId: string): Promise<boolean> {
    const extension = extensions().find((entry) => entry.id === appId);
    return extension?.reaches ? extension.reaches(userId) : false;
}

/** The panel an app draws on one of its installs' pages. */
export async function installedPanelSlot(install: ExtensionInstall): Promise<AppSlot | null> {
    for (const extension of extensions()) {
        const slot = await extension.installedPanelSlot?.(install);
        if (slot) return slot;
    }
    return null;
}
