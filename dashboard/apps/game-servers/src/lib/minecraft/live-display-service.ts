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
import { fillValues, readsPlayerList, readsServer, variablesIn } from "./text-vars";
import { spreadListLines } from "./rankings";
import { editionOf, onlinePlayers, onlineRoster, withServerContainer } from "./service";
import { audienceNames, namedByPolaris, parseTarget, type Roster } from "./announce-target";
import {
    ACTIONBAR_EVERY_MS,
    HELD_TITLE_EVERY_MS,
    announcementCommands,
    clearAnnouncementCommands,
    hasText,
    type Announcement,
    type SendContext
} from "./announcement";
import {
    SIDEBAR_LINES_MAX,
    readSidebar,
    sidebarCommands,
    sidebarOffCommands,
    sidebarRefusal,
    type SidebarConfig
} from "./sidebar";
import { PINNED_KEY, pinOver, pinnedAt, readPinned, type PinnedAnnouncement } from "./pinned";

const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;
const { subscribeMeetingEvents } = host.chatCalls;

/** How often the loop wakes. The action bar's period, the shortest of them. */
const TICK_MS = ACTIONBAR_EVERY_MS;
/** How often the panel and the values it shows are read again. */
const PANEL_EVERY_MS = 10_000;

interface Loop {
    readonly ownerId: string;
    readonly timer: ReturnType<typeof setInterval>;
    busy: boolean;
    lastActionbar: number;
    lastTitle: number;
    lastPanel: number;
    /** What the panel was last written as, or null when Polaris has not written it. */
    panel: { title: string; lines: string[] } | null;
    /** Moved on every pin and unpin, so a tick that read the one before sends nothing. */
    pinVersion: number;
    /** The values last read, reused until the panel's period is up. */
    context: { key: string; at: number; value: SendContext } | null;
    /** Whether what it shows reads a call, so a join or a leave redraws it. */
    readsCall: boolean;
    /** Who is on and who the operators are, last read, for a held announcement
     *  sent to an audience Polaris names itself. */
    roster: { at: number; value: Roster } | null;
}

const loops = new Map<string, Loop>();

/** Whether a text shows anything of a call. */
function readsCall(text: string): boolean {
    return variablesIn(text).some((use) => use.spec?.name.startsWith("call."));
}

let listening = false;

/**
 * Redraw every panel that shows a call the moment somebody joins or leaves one,
 * rather than on the panel's next period.
 *
 * Every loop that reads a call is marked due rather than only the one whose
 * group it was: the event names a meeting, not a group, and working out which
 * group that is would be a query per event to save a redraw that costs nothing
 * when the value did not change - `sidebarCommands` sends only what differs.
 * Somebody who goes without leaving - a closed tab, a lost connection - raises
 * no event, and is caught by the period instead, once the chat stops counting
 * them.
 */
function listenForCalls(): void {
    if (listening) return;
    listening = true;
    void subscribeMeetingEvents((event) => {
        if (event.kind !== "roster" && event.kind !== "ended") return;
        for (const loop of loops.values()) {
            if (!loop.readsCall) continue;
            loop.lastPanel = 0;
            loop.context = null;
        }
    }).catch((error: unknown) => {
        // Tried again with the next loop; until then the period still redraws.
        listening = false;
        console.warn("polaris: could not listen for call changes", String(error));
    });
}

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

/** Send lines to the game, stopping at the first it refuses. False when the
 *  server is not running and nothing was sent. */
async function say(
    ownerId: string,
    installedAppId: string,
    lines: readonly string[]
): Promise<boolean> {
    if (lines.length === 0) return true;
    return withServerContainer(ownerId, installedAppId, async (server) => {
        if (!server.running) return false;
        for (const line of lines) await server.say([line]);
        return true;
    });
}

/** The texts an announcement's repeats fill in. */
function heldTexts(announcement: Announcement): string[] {
    return [announcement.title, announcement.subtitle, announcement.actionbar];
}

const NOBODY: Roster = { players: [], operators: [] };

/** Who one held announcement is on the screens of, where Polaris names them. */
function namesFor(announcement: Announcement, roster: Roster): string[] {
    const audience = parseTarget(announcement.target);
    return audience ? audienceNames(audience, roster) : [];
}

/** What takes each of these off the screen. `roster` is who is on, for one
 *  sent to an audience Polaris names itself. */
function clearAll(
    edition: "java" | "bedrock",
    pinned: readonly (PinnedAnnouncement | null)[],
    roster: Roster = NOBODY
): string[] {
    return pinned
        .filter((one): one is PinnedAnnouncement => one !== null)
        .flatMap((one) =>
            clearAnnouncementCommands(edition, one.announcement, namesFor(one.announcement, roster))
        );
}

/** Whether any of these goes to an audience whose names have to be read. */
function toNamed(pinned: readonly (PinnedAnnouncement | null)[]): boolean {
    return pinned.some((one) => {
        const audience = one ? parseTarget(one.announcement.target) : null;
        return audience !== null && namedByPolaris(audience);
    });
}

/** How long who is on is taken as read. The same period as the panel's values:
 *  a moment's delay for somebody who has just come on. */
const ROSTER_EVERY_MS = 10_000;

/** Who is on and who the operators are, read at most once a period for a loop. */
async function rosterFor(installedAppId: string, loop: Loop, now: number): Promise<Roster> {
    const held = loop.roster;
    if (held && now - held.at < ROSTER_EVERY_MS) return held.value;
    const value = await onlineRoster(loop.ownerId, installedAppId).catch(
        () => held?.value ?? NOBODY
    );
    loop.roster = { at: now, value };
    return value;
}

async function tick(installedAppId: string, loop: Loop): Promise<void> {
    const version = loop.pinVersion;
    const settings = await settingsOf(installedAppId);
    if (!settings) return stopLoop(installedAppId);
    const now = Date.now();
    const stored = readPinned(settings.config);
    const pinned = pinnedAt(stored, now);
    const sidebar: SidebarConfig = readSidebar(settings.config);
    const panelOn = sidebar.enabled && sidebarRefusal(settings.edition, settings.release) === null;

    // Down at its moment, and taken off the screen rather than left to fade;
    // a held one it went over is back straight away.
    if (stored && pinned !== stored) {
        if (loop.pinVersion !== version) return;
        await patchInstallConfig(installedAppId, { [PINNED_KEY]: pinned });
        const gone = [stored, stored.underneath].filter((one) => one !== pinned);
        const roster = toNamed(gone) ? await rosterFor(installedAppId, loop, now) : NOBODY;
        await say(loop.ownerId, installedAppId, clearAll(settings.edition, gone, roster)).catch(
            () => undefined
        );
        loop.lastActionbar = 0;
        loop.lastTitle = 0;
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
        ...(panelOn ? [sidebar.title, ...sidebar.lines] : [])
    ];
    loop.readsCall = texts.some(readsCall);
    const context = await contextFor(installedAppId, loop, texts, now, duePanel);

    // Held for the operators, or everybody but them: whoever of them is on now,
    // read at most once a period. With none on there is nobody to keep it up
    // for - which is not a failure, and the panel beside it still goes.
    const held =
        pinned && toNamed([pinned])
            ? {
                  ...context,
                  named: namesFor(pinned.announcement, await rosterFor(installedAppId, loop, now))
              }
            : context;
    const repeat = (part: "title" | "actionbar"): string[] => {
        if (!pinned) return [];
        if (held.named?.length === 0) return [];
        return announcementCommands(settings.edition, pinned.announcement, held, part);
    };
    const lines: string[] = [];
    if (pinned && dueTitle) {
        lines.push(...repeat("title"));
        loop.lastTitle = now;
    }
    if (pinned && dueBar) {
        lines.push(...repeat("actionbar"));
        loop.lastActionbar = now;
    }
    let panel: Loop["panel"] = null;
    if (duePanel) {
        const title = fillValues(sidebar.title, context.values);
        // A list - everybody's level, a leaderboard - is a line a row here,
        // in the room the other lines leave.
        const spread = spreadListLines(sidebar.lines, context.lists ?? {}, SIDEBAR_LINES_MAX);
        const shownLines = spread.map((line) => fillValues(line, context.values));
        lines.push(...sidebarCommands(title, shownLines, loop.panel));
        panel = { title, lines: shownLines };
        loop.lastPanel = now;
    } else if (!panelOn && loop.panel) {
        lines.push(...sidebarOffCommands());
    }
    if (loop.pinVersion !== version) return;
    const sent = await say(loop.ownerId, installedAppId, lines).catch((error: unknown) => {
        // Written from scratch next time: nothing here knows how far it got.
        if (duePanel) loop.panel = null;
        throw error;
    });
    if (duePanel) loop.panel = sent ? panel : null;
    else if (!panelOn && sent) loop.panel = null;
}

/**
 * The values the texts are written with, read again when the texts change, when
 * the panel is due, or once the panel's period is up - not on every action bar,
 * which would ask the server who is on every two seconds.
 */
async function contextFor(
    installedAppId: string,
    loop: Loop,
    texts: readonly string[],
    now: number,
    fresh: boolean
): Promise<SendContext> {
    const key = JSON.stringify(texts);
    const cached = loop.context;
    if (!fresh && cached && cached.key === key && now - cached.at < PANEL_EVERY_MS) {
        return cached.value;
    }
    const needsList = texts.some((text) => readsPlayerList(text));
    const players = needsList
        ? await onlinePlayers(loop.ownerId, installedAppId).catch(() => null)
        : null;
    // Asked of the running server only when a text reads its log or everybody's
    // level; the rest is Polaris's own and costs the server nothing.
    // Loaded when a leaderboard asks for them, not with the loop: most panels
    // never read a statistics file.
    const figures = async () =>
        (await import("./stats-service")).readAllPlayerStats(loop.ownerId, installedAppId);
    const value = texts.some((text) => readsServer(text))
        ? await withServerContainer(loop.ownerId, installedAppId, (server) =>
              liveContext(installedAppId, texts, players, server.running ? server : null, figures)
          ).catch(() => liveContext(installedAppId, texts, players, null, figures))
        : await liveContext(installedAppId, texts, players);
    loop.context = { key, at: now, value };
    return value;
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
    loopFor(ownerId, installedAppId);
}

function loopFor(ownerId: string, installedAppId: string): Loop {
    const running = loops.get(installedAppId);
    if (running) return running;
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
        panel: null,
        pinVersion: 0,
        context: null,
        readsCall: false,
        roster: null
    };
    listenForCalls();
    // A loop must never keep the process alive on its own.
    loop.timer.unref?.();
    loops.set(installedAppId, loop);
    return loop;
}

/**
 * Record an announcement to keep up after it was sent, and start its loop.
 * One is on top at a time, so the screen never has two held titles fighting
 * over it; a timed one goes over a held one and gives the screen back to it
 * when its time is over (`pinOver`).
 */
export async function pinAnnouncement(
    ownerId: string,
    installedAppId: string,
    announcement: Announcement,
    sentAt: number
): Promise<PinnedAnnouncement> {
    const settings = await settingsOf(installedAppId);
    const current = settings ? pinnedAt(readPinned(settings.config), sentAt) : null;
    const pinned = pinOver(current, announcement, sentAt);
    await patchInstallConfig(installedAppId, { [PINNED_KEY]: pinned });
    const loop = loopFor(ownerId, installedAppId);
    // The new one is sent straight away by the caller; the repeats start from
    // then, not from where the last one's were.
    loop.pinVersion += 1;
    loop.lastActionbar = sentAt;
    loop.lastTitle = sentAt;
    return pinned;
}

/** Take the pinned announcement, and any held one under it, down now. */
export async function unpinAnnouncement(ownerId: string, installedAppId: string): Promise<void> {
    const settings = await settingsOf(installedAppId);
    const pinned = settings ? readPinned(settings.config) : null;
    await patchInstallConfig(installedAppId, { [PINNED_KEY]: null });
    const loop = loops.get(installedAppId);
    if (loop) loop.pinVersion += 1;
    if (!settings || !pinned) return;
    const both = [pinned, pinned.underneath];
    const roster = toNamed(both)
        ? await onlineRoster(ownerId, installedAppId).catch(() => NOBODY)
        : NOBODY;
    await say(ownerId, installedAppId, clearAll(settings.edition, both, roster));
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
