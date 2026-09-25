/**
 * What Polaris keeps on the players' screens by sending it again: an
 * announcement meant to stay longer than the game keeps it up on its own, and
 * the side panel with its values current.
 *
 * The game gives an action bar about three seconds and a title as long as its
 * timings say, and forgets both; it has no "until nine o'clock" and no "until I
 * take it down". So a running server with something pinned, or a panel switched
 * on, gets a loop in this process that sends the action bar every two seconds,
 * the title every ten, and the panel's lines when their values change.
 *
 * The loop is memory, and a restart or an update takes it. What it is for is
 * on the install's settings, so the minute sweep (`sweepLiveDisplays`) starts
 * it again - a pinned line is back within a minute of Polaris coming up, and an
 * "until" that passed while it was down is taken down rather than resumed.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { liveContext } from "./live-values";
import { fillValues, readsPlayerList } from "./text-vars";
import { editionOf, onlinePlayers, withServerContainer } from "./service";
import {
    ACTIONBAR_EVERY_MS,
    HELD_TITLE_EVERY_MS,
    announcementCommands,
    hasText,
    holdEndsAt,
    type Announcement
} from "./announcement";
import {
    readSidebar,
    sidebarCommands,
    sidebarOffCommands,
    sidebarRefusal,
    type SidebarConfig
} from "./sidebar";
import { announcementSchema } from "./announcement-templates";

const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;

/** Where the announcement being kept up is recorded on the install. */
export const PINNED_KEY = "pinnedAnnouncement";

/** An announcement being kept on screen, and when it comes down. */
export interface PinnedAnnouncement {
    readonly announcement: Announcement;
    readonly sentAt: number;
    /** A moment, or null for "until somebody takes it down". */
    readonly endsAt: number | null;
}

/** How often the loop wakes. The action bar's period, the shortest of them. */
const TICK_MS = ACTIONBAR_EVERY_MS;
/** How often the panel and the values it shows are read again. */
const PANEL_EVERY_MS = 10_000;

export function readPinned(config: Record<string, unknown>): PinnedAnnouncement | null {
    const stored = config[PINNED_KEY] as Record<string, unknown> | null | undefined;
    if (!stored || typeof stored !== "object") return null;
    const announcement = announcementSchema.safeParse(stored.announcement);
    if (!announcement.success) return null;
    const sentAt = Number(stored.sentAt);
    const endsAt = stored.endsAt === null ? null : Number(stored.endsAt);
    if (!Number.isFinite(sentAt) || (endsAt !== null && !Number.isFinite(endsAt))) return null;
    return { announcement: announcement.data, sentAt, endsAt };
}

interface Loop {
    readonly ownerId: string;
    readonly timer: ReturnType<typeof setInterval>;
    busy: boolean;
    lastActionbar: number;
    lastTitle: number;
    lastPanel: number;
    /** What the panel was last written as, or null when Polaris has not written it. */
    panel: { title: string; lines: string[] } | null;
}

const loops = new Map<string, Loop>();

async function settingsOf(installedAppId: string): Promise<{
    config: Record<string, unknown>;
    release: string | null;
    edition: "java" | "bedrock";
} | null> {
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true, catalogId: true, status: true }
    });
    if (!row || row.status === "removed") return null;
    const config = readInstallConfig(row.config);
    const release = typeof config.mcRelease === "string" ? config.mcRelease : null;
    return {
        config,
        release,
        edition: editionOf(row.catalogId)
    };
}

/** Send lines to the game, stopping at the first it refuses. */
async function say(
    ownerId: string,
    installedAppId: string,
    lines: readonly string[]
): Promise<void> {
    if (lines.length === 0) return;
    await withServerContainer(ownerId, installedAppId, async (server) => {
        if (!server.running) return;
        for (const line of lines) await server.say([line]);
    });
}

/** The texts an announcement's repeats fill in. */
function heldTexts(announcement: Announcement): string[] {
    return [announcement.title, announcement.subtitle, announcement.actionbar];
}

async function tick(installedAppId: string, loop: Loop): Promise<void> {
    const settings = await settingsOf(installedAppId);
    if (!settings) return stopLoop(installedAppId);
    const now = Date.now();
    let pinned = readPinned(settings.config);
    const sidebar: SidebarConfig = readSidebar(settings.config);
    const panelOn = sidebar.enabled && sidebarRefusal(settings.edition, settings.release) === null;

    // Down at its moment, and taken off the screen rather than left to fade.
    if (pinned && pinned.endsAt !== null && now >= pinned.endsAt) {
        await patchInstallConfig(installedAppId, { [PINNED_KEY]: null });
        await say(loop.ownerId, installedAppId, clearCommands(pinned.announcement)).catch(
            () => undefined
        );
        pinned = null;
    }

    if (!pinned && !panelOn) {
        if (loop.panel) {
            await say(loop.ownerId, installedAppId, sidebarOffCommands()).catch(() => undefined);
        }
        return stopLoop(installedAppId);
    }

    const dueBar =
        pinned &&
        hasText(pinned.announcement.actionbar) &&
        now - loop.lastActionbar >= TICK_MS - 250;
    const dueTitle =
        pinned &&
        pinned.announcement.hold !== "timed" &&
        (hasText(pinned.announcement.title) || hasText(pinned.announcement.subtitle)) &&
        now - loop.lastTitle >= HELD_TITLE_EVERY_MS;
    const duePanel = panelOn && now - loop.lastPanel >= PANEL_EVERY_MS;
    if (!dueBar && !dueTitle && !duePanel) return;

    const texts = [
        ...(pinned ? heldTexts(pinned.announcement) : []),
        ...(duePanel ? [sidebar.title, ...sidebar.lines] : [])
    ];
    const needsList = texts.some((text) => readsPlayerList(text));
    const players = needsList
        ? await onlinePlayers(loop.ownerId, installedAppId).catch(() => null)
        : null;
    const context = await liveContext(installedAppId, texts, players);

    const lines: string[] = [];
    if (pinned && dueTitle) {
        lines.push(
            ...announcementCommands(settings.edition, pinned.announcement, context, "title")
        );
        loop.lastTitle = now;
    }
    if (pinned && dueBar) {
        lines.push(
            ...announcementCommands(settings.edition, pinned.announcement, context, "actionbar")
        );
        loop.lastActionbar = now;
    }
    if (duePanel) {
        const title = fillValues(sidebar.title, context.values);
        const shownLines = sidebar.lines.map((line) => fillValues(line, context.values));
        lines.push(...sidebarCommands(title, shownLines, loop.panel));
        loop.panel = { title, lines: shownLines };
        loop.lastPanel = now;
    } else if (!panelOn && loop.panel) {
        lines.push(...sidebarOffCommands());
        loop.panel = null;
    }
    await say(loop.ownerId, installedAppId, lines);
}

/** What takes a pinned announcement off the screen straight away. */
function clearCommands(announcement: Announcement): string[] {
    const target = announcement.target;
    const lines: string[] = [];
    if (hasText(announcement.title) || hasText(announcement.subtitle)) {
        lines.push(`title ${target} clear`);
    }
    if (hasText(announcement.actionbar)) {
        lines.push(`title ${target} actionbar {"text":""}`);
    }
    return lines;
}

function stopLoop(installedAppId: string): void {
    const loop = loops.get(installedAppId);
    if (loop) clearInterval(loop.timer);
    loops.delete(installedAppId);
}

/**
 * Make sure a server with something to keep up has its loop, starting one if
 * it has none. Cheap to call again: a running loop is left as it is.
 */
export function startLiveDisplay(ownerId: string, installedAppId: string): void {
    if (loops.has(installedAppId)) return;
    const loop: Loop = {
        ownerId,
        timer: setInterval(() => {
            if (loop.busy) return;
            loop.busy = true;
            void tick(installedAppId, loop)
                .catch((error: unknown) => {
                    // A server that stopped or is restarting does not answer for
                    // a while; the next tick asks again.
                    console.warn(
                        "polaris: live display tick failed",
                        installedAppId,
                        String(error)
                    );
                })
                .finally(() => {
                    loop.busy = false;
                });
        }, TICK_MS),
        busy: false,
        lastActionbar: 0,
        lastTitle: 0,
        lastPanel: 0,
        panel: null
    };
    // A loop must never keep the process alive on its own.
    loop.timer.unref?.();
    loops.set(installedAppId, loop);
}

/**
 * Record an announcement to keep up after it was sent, and start its loop.
 * Replaces whatever was pinned on this server: one at a time, so the screen
 * never has two held titles fighting over it.
 */
export async function pinAnnouncement(
    ownerId: string,
    installedAppId: string,
    announcement: Announcement,
    sentAt: number
): Promise<PinnedAnnouncement> {
    const pinned: PinnedAnnouncement = {
        announcement,
        sentAt,
        endsAt: holdEndsAt(announcement, sentAt)
    };
    await patchInstallConfig(installedAppId, { [PINNED_KEY]: pinned });
    const loop = loops.get(installedAppId);
    if (loop) {
        // The new one is sent straight away by the caller; the repeats start
        // from now, not from where the last one's were.
        loop.lastActionbar = sentAt;
        loop.lastTitle = sentAt;
    }
    startLiveDisplay(ownerId, installedAppId);
    return pinned;
}

/** Take the pinned announcement down now. */
export async function unpinAnnouncement(ownerId: string, installedAppId: string): Promise<void> {
    const settings = await settingsOf(installedAppId);
    const pinned = settings ? readPinned(settings.config) : null;
    await patchInstallConfig(installedAppId, { [PINNED_KEY]: null });
    if (pinned) await say(ownerId, installedAppId, clearCommands(pinned.announcement));
}

/**
 * Apply the panel now rather than on the next tick, and start or keep the loop.
 * Switched off, it is taken off every screen at once.
 */
export async function applySidebar(ownerId: string, installedAppId: string): Promise<void> {
    const loop = loops.get(installedAppId);
    if (loop) {
        loop.lastPanel = 0;
    }
    const settings = await settingsOf(installedAppId);
    const sidebar = settings ? readSidebar(settings.config) : null;
    if (!sidebar?.enabled) {
        if (loop) loop.panel = null;
        await say(ownerId, installedAppId, sidebarOffCommands());
        return;
    }
    startLiveDisplay(ownerId, installedAppId);
}

/**
 * The minute sweep: every server with something pinned or a panel switched on
 * gets its loop back after a restart. The loop itself decides when there is
 * nothing left to do and stops.
 */
export async function sweepLiveDisplays(): Promise<{ running: number }> {
    const rows = await prisma.installedApp.findMany({
        where: {
            status: { not: "removed" },
            catalogId: { in: ["minecraft", "minecraft-bedrock"] }
        },
        select: { id: true, ownerId: true, config: true }
    });
    for (const row of rows) {
        const config = readInstallConfig(row.config);
        if (readPinned(config) || readSidebar(config).enabled) {
            startLiveDisplay(row.ownerId, row.id);
        }
    }
    return { running: loops.size };
}
