/**
 * Running a Minecraft server's events.
 *
 * An event is a loop in this process, one per server, ticking every two seconds
 * for as long as the event lasts: the countdown, the boss bar, the scoreboard
 * worked out by the game, the chest found, the boss felled, the trivia answer
 * spotted in the chat. What it is doing is written to the install's config at
 * every step that matters, so a Polaris that restarts mid-event picks it up
 * again from the minute sweep (`sweepEvents`) - or, if the moment has passed,
 * finishes it properly rather than leaving a boss wandering and a chest loaded.
 *
 * The same sweep is what starts the automatic ones - scheduled at a time, or
 * drawn at random while enough people are actually playing - and hands out
 * prizes to anybody who was offline when they were won.
 */

import * as plan from "./plan";
import * as stored from "./state";
import { readXray } from "../xray";
import * as speech from "../speech";
import { prisma } from "@polaris/db";
import * as catalog from "./catalog";
import * as replies from "./replies";
import * as service from "../service";
import * as written from "./messages";
import * as waves from "./kinds/waves";
import * as commands from "./commands";
import * as stage from "./kinds/stage";
import * as playing from "../activity";
import * as delivery from "../delivery";
import * as trivia from "./trivia-bank";
import * as chunks from "./kinds/chunks";
import { host } from "@polaris/app-host";
import * as duel from "./kinds/team-duel";
import * as boost from "./kinds/xp-boost";
import { parseProperties } from "../parse";
import { readSchedule } from "../schedule";
import * as parkour from "./kinds/parkour";
import { withTimeout } from "@polaris/core";
import * as gather from "./kinds/gathering";
import * as hunt from "./kinds/treasure-hunt";
import * as rareCatch from "./kinds/rare-catch";
import * as meteors from "./kinds/meteor-shower";
import * as speechService from "../speech-service";
import * as bossService from "./kinds/boss-service";
import type { GameKey } from "../../../../messages";
import * as stageService from "./kinds/stage-service";
import * as arenaService from "./kinds/arena-service";
import * as stashService from "./kinds/stash-service";
import * as search from "./place-search";
import * as hillService from "./kinds/hill-service";
import { editionOf, type ServerContainer } from "../service";
import { gameMessage, gameMessageIn } from "../../game-message";
import { holdSidebar, releaseSidebar } from "../live-display-service";
import { containerFileSize, readContainerFile, readContainerRange } from "../../container-files";

type RefusalKey =
    GameKey<"minecraft"> extends infer K
        ? K extends `events.errors.${infer R}`
            ? R
            : never
        : never;

/** Why the screen's request was refused, carried as its catalog key until the
 *  action that answers it writes it in the reader's language (`messageText`). */
function refused(key: RefusalKey, params?: Readonly<Record<string, string | number>>): string {
    return gameMessage("minecraft", `events.errors.${key}`, params);
}

/** A carried sentence in the history's own words, which are English. */
const english = (text: string): string => gameMessageIn("en-US", text);

/** What players read, in one language or - given `speech.EVERY` - in every one. */
const messages = speech.spoken(written);

const { readInstallConfig } = host.appsInstallConfig;

/** How long what kind of server one is stays known: it changes only with a restart. */
const KIND_KNOWN_MS = 10 * 60_000;
const bukkitServers = new Map<string, { at: number; bukkit: boolean }>();

/**
 * The server an event talks to: every line it is sent named as vanilla's own
 * command on a Bukkit-family server (`commands.namespaced`), where a plugin's
 * command of the same name would otherwise answer instead. Which kind it is is
 * asked once and remembered; a server that does not answer is asked again.
 *
 * And every answer to a read of all the players made readable by name
 * (`replies`): asked again a page at a time when it came back cut short, and
 * split by the names online when the game ran the answers together or wrote
 * them with a team's prefix.
 */
function eventServer(server: ServerContainer, installedAppId: string): ServerContainer {
    const bukkit = async (): Promise<boolean> => {
        const known = bukkitServers.get(server.installedAppId);
        if (known && Date.now() - known.at < KIND_KNOWN_MS) return known.bukkit;
        if (server.edition !== "java") return false;
        const said = await server.say([commands.BUKKIT_PROBE]).catch(() => "");
        if (said.trim().length > 0)
            bukkitServers.set(server.installedAppId, {
                at: Date.now(),
                bukkit: commands.isBukkit(said)
            });
        return commands.isBukkit(said);
    };
    const named = async (lines: readonly string[]) =>
        (await bukkit()) ? lines.map(commands.namespaced) : lines;
    const one = async (line: string) => server.say(await named([line]));
    const paged = async (line: string, whole: string): Promise<string> => {
        const pages = replies.pagedRead(line);
        if (!pages) return whole;
        await server.sayAll(await named(pages.start));
        const read: string[] = [];
        try {
            for (let page = 0; page < 25; page += 1) {
                if (!replies.pageTagged(await one(pages.tagPage))) break;
                read.push(await one(pages.readPage));
                await server.sayAll(await named(pages.next));
            }
        } finally {
            await server.sayAll(await named([...pages.next.slice(1), ...pages.end]));
        }
        return read.join("\n");
    };
    // Each line split for who reads which language, before anything else.
    const audience = () =>
        speechService.audienceFor(installedAppId, homes.get(installedAppId) ?? "en");
    return {
        ...server,
        say: async (argv) => {
            const written = argv.join(" ");
            const split = speech.localize(written, audience());
            if (split.length !== 1 || split[0] !== written) {
                const said: string[] = [];
                for (const line of split) said.push(await one(line));
                return said.join("");
            }
            const line = written;
            const said = await one(line);
            if (!replies.isPlayerRead(line)) return said;
            const whole = replies.cutShort(said) ? await paged(line, said) : said;
            const read = replies.canonicalReplies(whole, null);
            if (!read.needsRoster) return read.text;
            const roster = replies.rosterNames(await one(replies.ROSTER).catch(() => ""));
            return replies.canonicalReplies(whole, roster).text;
        },
        sayAll: async (lines) => server.sayAll(await named(speech.localizeAll(lines, audience())))
    };
}

/** Each server's own language, as its event loop last settled it. */
const homes = new Map<string, catalog.Language>();

/**
 * Who reads which language: the server's own settled first (chosen, or its
 * owner's), then who is on looked at again every few seconds and tagged.
 */
async function hearPlayers(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer
): Promise<void> {
    if (!loop.homeKnown) {
        const row = await readRow(installedAppId).catch(() => null);
        loop.home = await speechService.homeLanguage(
            loop.ownerId,
            row ? catalog.chosenLanguage(row.config) : loop.home
        );
        loop.homeKnown = true;
    }
    homes.set(installedAppId, loop.home);
    await speechService.hear(installedAppId, server, loop.home).catch(() => undefined);
}

function withServerContainer<T>(
    ownerId: string,
    installedAppId: string,
    work: (server: ServerContainer) => Promise<T>
): Promise<T> {
    return service.withServerContainer(ownerId, installedAppId, (server) =>
        work(eventServer(server, installedAppId))
    );
}

async function openServerContainer(
    ownerId: string,
    installedAppId: string
): Promise<{ server: ServerContainer; close: () => Promise<void> }> {
    const link = await service.openServerContainer(ownerId, installedAppId);
    return { server: eventServer(link.server, installedAppId), close: link.close };
}

const TICK_MS = 2_000;
/** How often the boss bar's clock moves: every second, on its own timer. */
const CLOCK_MS = 1_000;
/** How often a parkour race is looked at for falls and checkpoints: a fall is
 *  caught before the ground, a checkpoint as it is stepped on. One batch each. */
const QUICK_MS = 400;
/** How often the loop looks at who is where, to know who took part. */
const SAMPLE_EVERY_MS = 15_000;
/** How often the participants are written down, so a restart knows them. */
const SAVE_EVERY_MS = 60_000;
/** How long a server that stopped answering is waited for past an event's end. */
const GIVE_UP_AFTER_MS = 2 * 60_000;
/** How many places are tried before an event that needs one gives up. */
const PLACE_TRIES = 10;

/** How long where everybody sleeps is taken as known while a place is looked for. */
const HOMES_KEPT_MS = 30_000;

/** After how many tries an event that may come near a home starts coming in closer. */
const NEAR_AFTER = 4;

/** How a place is looked for: on land to stand on, or anywhere nothing is built
 *  for what goes up in the air; and whether it may come in near a home. */
interface PlaceHow {
    /**
     * `ground`: on the world's own walkable ground. `open`: the same, with open
     * water as good as land. `air`: built in the air - nothing under it matters,
     * a build or the sea, only the air it takes; the point answered stands on
     * top of the highest thing in its footprint (plus `lift`).
     */
    readonly surface?: "ground" | "open" | "air";
    /** For `air`: how far above the highest thing in its footprint. */
    readonly lift?: number;
    readonly nearHome?: boolean;
    /** The way to look, in radians from north (`commands.pointAway`). */
    readonly bearing?: number;
    /** Only somewhere the players can walk to from here (`commands.walkable`):
     *  on an island, the island. */
    readonly walkFrom?: { x: number; z: number };
}

/** How many tries a search has, counted from where it starts (`Loop.placeFloor`). */
function placeLimit(loop: Loop, nearHome: boolean): number {
    return PLACE_TRIES + (nearHome ? loop.placeFloor + NEAR_TRIES : 0);
}

/** The tries a search that may come in near a home has besides: the ground of
 *  a small island is mostly a home, a farm and a shore, and a try there is
 *  quick - every column of it judged in a few commands. */
const NEAR_TRIES = 10;
/** How much ground a chest or a boss is judged by around where it goes. */
const SPOT_RADIUS = 3;
const WRITE_TRIES = 5;
const LOG_DIR = "/data/logs";
const LOG_FILE = `${LOG_DIR}/latest.log`;
const SERVER_PROPERTIES = "/data/server.properties";

interface Loop {
    readonly ownerId: string;
    readonly timer: ReturnType<typeof setInterval>;
    /** The boss bar's clock, a second at a time, apart from the tick. */
    clock: ReturnType<typeof setInterval> | null;
    /** Parkour and a team duel: the quick look, far oftener than the tick -
     *  falls and checkpoints, or whoever was brought low. */
    quick: ReturnType<typeof setInterval> | null;
    quickBusy: boolean;
    busy: boolean;
    run: stored.EventRun;
    link: { server: ServerContainer; close: () => Promise<void> } | null;
    ticks: number;
    lastSample: number;
    lastSave: number;
    /** Its results are being handed out: no tick, sweep or Cancel plays it again. */
    finishing: boolean;
    /** Trivia: how long the log was when the round was asked. */
    logFrom: number | null;
    /** Which names this server knows its ground blocks by, once asked; `none`
     *  when it refuses a name in every list and the ground cannot be judged. */
    ground: commands.GroundNames | "none" | null;
    /** The countdown marks already sounded, in seconds before the start. */
    sounded: Set<number>;
    announced: boolean;
    /** Always every language: each line is split for its readers on the way out. */
    language: speech.Speech;
    /** The server's own language: what a player nobody knows reads, and what
     *  nobody in particular reads (a boss bar's name, a side panel's title). */
    home: catalog.Language;
    /** Whether `home` is settled: chosen, or the owner's looked up. */
    homeKnown: boolean;
    /** Whether this loop has seen the event not yet playable: its clock then
     *  starts when it becomes so, rather than keeping the start it had. */
    sawUnready: boolean;
    countdown: number;
    /** Parkour and spleef: how this server spells marked items, and its build limit. */
    flavour: stage.Flavour | null;
    /** Whether operators' chat has been quietened for this run yet. */
    quiet: boolean;
    /** Where players online sleep, as last asked (`homesOf`). */
    homes: { at: number; list: { x: number; z: number }[] } | null;
    /** Where a search that may come in near a home (`PlaceHow.nearHome`) starts,
     *  in tries: where the last one had to come to before it found anything - an
     *  island, where nothing further out ever does. Forgotten on a restart. */
    placeFloor: number;
}

const loops = new Map<string, Loop>();

// ------------------------------------------------------------------ storage

interface Row {
    readonly ownerId: string;
    readonly name: string;
    readonly catalogId: string;
    readonly config: Record<string, unknown>;
}

async function readRow(installedAppId: string): Promise<Row | null> {
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { ownerId: true, name: true, catalogId: true, status: true, config: true }
    });
    if (!row || row.status === "removed" || !row.catalogId.startsWith("minecraft")) return null;
    return {
        ownerId: row.ownerId,
        name: row.name,
        catalogId: row.catalogId,
        config: readInstallConfig(row.config)
    };
}

/** The settings as the screen sees them, with the schedule's zone as the default. */
function settingsOf(config: Record<string, unknown>): catalog.EventsConfig {
    return catalog.readEventsConfig(config, readSchedule(config).timezone);
}

/** How long without moving before a player counts as AFK on this server. */
export async function afkMinutesFor(installedAppId: string): Promise<number> {
    const row = await readRow(installedAppId);
    return settingsOf(row?.config ?? {}).settings.afkMinutes;
}

/**
 * Change what is remembered from what is stored now, never from a stale copy:
 * the write only lands if nothing changed it since it was read, and is worked
 * out again otherwise.
 */
export async function updateEventState(
    installedAppId: string,
    change: (state: stored.EventState) => stored.EventState
): Promise<stored.EventState | null> {
    for (let attempt = 0; attempt < WRITE_TRIES; attempt += 1) {
        const row = await prisma.installedApp.findUnique({
            where: { id: installedAppId },
            select: { config: true, status: true }
        });
        if (!row || row.status === "removed") return null;
        const config = readInstallConfig(row.config);
        const next = change(stored.readEventState(config));
        const written = await prisma.installedApp.updateMany({
            where: { id: installedAppId, config: row.config },
            data: { config: JSON.stringify({ ...config, [catalog.EVENT_STATE_KEY]: next }) }
        });
        if (written.count > 0) return next;
    }
    throw new Error(refused("keptChanging"));
}

/** Save the events set up on the screen. Checked again here: this is the one
 *  that decides. */
export async function saveEventsConfig(
    installedAppId: string,
    input: unknown
): Promise<catalog.EventsConfig> {
    const parsed = catalog.eventsConfigSchema.safeParse(input);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? refused("check"));
    const value = parsed.data;
    for (let attempt = 0; attempt < WRITE_TRIES; attempt += 1) {
        const row = await prisma.installedApp.findUnique({
            where: { id: installedAppId },
            select: { config: true, status: true }
        });
        if (!row || row.status === "removed") throw new Error(refused("noServer"));
        const config = readInstallConfig(row.config);
        const written = await prisma.installedApp.updateMany({
            where: { id: installedAppId, config: row.config },
            data: { config: JSON.stringify({ ...config, [catalog.EVENTS_KEY]: value }) }
        });
        if (written.count > 0) {
            // The draw is armed again from the new settings: a gap shortened
            // or the draw switched on takes effect from now, not from whenever
            // the old one would have come round.
            await updateEventState(installedAppId, (state) => ({
                ...state,
                nextRandomAt: null,
                waiting: null
            }));
            return value;
        }
    }
    throw new Error(refused("keptChanging"));
}

// ------------------------------------------------------------------ what the screen shows

export interface EventsView {
    readonly config: catalog.EventsConfig;
    readonly run: {
        readonly presetId: string;
        readonly name: string;
        readonly kind: catalog.EventKind;
        readonly phase: "countdown" | "running";
        readonly startsAt: number;
        readonly endsAt: number;
        readonly trigger: stored.EventTrigger;
        readonly cancelling: boolean;
        /** The scoreboard as it stands, best first. */
        readonly standings: readonly { name: string; score: number }[];
    } | null;
    readonly history: readonly stored.EventHistoryEntry[];
    readonly pending: readonly stored.PendingReward[];
    /** Players' own things an event could not give back whole: kept in their
     *  barrels, shown until given back from here or dismissed. */
    readonly stashFailures: Awaited<ReturnType<typeof stashService.failedStashes>>;
    readonly nextRandomAt: number | null;
    readonly waiting: string | null;
    /** When the sweep last looked at the draw in this process, or null. */
    readonly drawCheckedAt: number | null;
    /** The last event the draw started, among those kept, or null. */
    readonly lastRandom: { readonly name: string; readonly startedAt: number } | null;
    /** Who is on and who of them is playing, as the last look saw them. Null when
     *  nobody has looked yet. */
    readonly players: { readonly online: number; readonly active: number } | null;
    readonly refusal: string | null;
}

/** The last event the draw started: the one on now, or the newest kept. */
function lastRandomOf(state: stored.EventState): { name: string; startedAt: number } | null {
    if (state.run?.trigger === "random")
        return { name: state.run.preset.name, startedAt: state.run.startsAt };
    const found = state.history.find((entry) => entry.trigger === "random");
    return found ? { name: found.name, startedAt: found.startedAt } : null;
}

/**
 * Draw an event now, from the screen: one of the pool whose conditions hold -
 * switched on, and the players it needs - by weight, not the same kind as last
 * time when there is another. The hours, the gap and a fight somebody is in do
 * not hold it back: the operator pressed the button. Says what it picked, and
 * why each of the others was not.
 */
export async function runRandomNow(input: {
    ownerId: string;
    installedAppId: string;
    startedBy: string;
}): Promise<{ run: stored.EventRun | null; skipped: plan.Skipped[] }> {
    const row = await readRow(input.installedAppId);
    if (!row) throw new Error(refused("noServer"));
    const settings = settingsOf(row.config);
    const state = stored.readEventState(row.config);
    if (state.run) throw new Error(gameMessage("minecraft", "events.waiting.anotherOn"));
    if (settings.settings.random.pool.length === 0)
        throw new Error(gameMessage("minecraft", "events.skipped.emptyPool"));
    const seen = await sample(input.ownerId, input.installedAppId);
    if (seen === null) throw new Error(refused("notRunning"));
    const now = Date.now();
    const { choices, skipped } = plan.drawable({
        settings: settings.settings,
        presets: settings.presets,
        lastKind: state.lastKind,
        activeFor: (preset) =>
            plan.playersFor(preset, seen, settings.settings.afkMinutes, now).length
    });
    const chosen = plan.pickWeighted(choices, Math.random);
    if (!chosen) return { run: null, skipped };
    const run = await startEvent({
        ownerId: input.ownerId,
        installedAppId: input.installedAppId,
        presetId: chosen.id,
        trigger: "random",
        startedBy: input.startedBy
    });
    // The next drawn one a gap after this one, as if the draw had picked it.
    await updateEventState(input.installedAppId, (current) => ({
        ...current,
        nextRandomAt: now + catalog.runMinutes(chosen) * 60_000 + plan.nextGap(settings.settings, Math.random),
        waiting: null,
        short: false,
        readySince: null
    }));
    return { run, skipped };
}

export async function eventsView(installedAppId: string): Promise<EventsView> {
    const row = await readRow(installedAppId);
    if (!row) throw new Error(refused("noServer"));
    // A server that never saved its events is shown one of each, named in the
    // language its players read - which is what saving them keeps.
    const config = catalog.readEventsConfig(
        row.config,
        readSchedule(row.config).timezone,
        await speechService.homeLanguage(row.ownerId, catalog.chosenLanguage(row.config))
    );
    const state = stored.readEventState(row.config);
    const run = loops.get(installedAppId)?.run ?? state.run;
    let standings: { name: string; score: number }[] = [];
    if (run && run.phase === "running" && catalog.KIND_INFO[run.preset.kind].competitive) {
        // Bounded: the screen asks every few seconds, and a server slow to answer
        // must not hold the rest of what it shows.
        standings = await withTimeout(
            sharedStandings(row.ownerId, installedAppId, run),
            3_000,
            "slow"
        ).catch(() => []);
    }
    const seen = playing.seenOn(installedAppId);
    return {
        config,
        run: run
            ? {
                  presetId: run.preset.id,
                  name: run.preset.name,
                  kind: run.preset.kind,
                  phase: run.phase,
                  startsAt: run.startsAt,
                  endsAt: run.endsAt,
                  trigger: run.trigger,
                  cancelling: run.cancelled,
                  standings
              }
            : null,
        history: state.history,
        pending: stored.livePending(state.pending, Date.now()),
        stashFailures: await stashService.failedStashes(installedAppId).catch(() => []),
        nextRandomAt: state.nextRandomAt,
        waiting: state.waiting,
        drawCheckedAt: drawChecks.get(installedAppId) ?? null,
        lastRandom: lastRandomOf(state),
        players: seen
            ? {
                  online: seen.size,
                  active: plan.activePlayers(seen, config.settings.afkMinutes, Date.now()).length
              }
            : null,
        refusal:
            editionOf(row.catalogId) === "bedrock"
                ? "Events run on Java servers; Bedrock has no scoreboard statistics or boss bars to play them with"
                : null
    };
}

/** Reads of the standings still out, one per server: a read slower than the
 *  screen's polling is joined, not stacked behind another. */
const standingsReads = new Map<string, Promise<{ name: string; score: number }[]>>();

function sharedStandings(
    ownerId: string,
    installedAppId: string,
    run: stored.EventRun
): Promise<{ name: string; score: number }[]> {
    const pending = standingsReads.get(installedAppId);
    if (pending) return pending;
    const read = currentStandings(ownerId, installedAppId, run).finally(() =>
        standingsReads.delete(installedAppId)
    );
    standingsReads.set(installedAppId, read);
    return read;
}

async function currentStandings(
    ownerId: string,
    installedAppId: string,
    run: stored.EventRun
): Promise<{ name: string; score: number }[]> {
    if (run.preset.kind === "trivia" || run.preset.kind === "treasure-hunt") {
        return Object.entries(run.points)
            .map(([name, score]) => ({ name, score }))
            .sort((left, right) => right.score - left.score);
    }
    if (catalog.playsOnStage(run.preset)) return stageService.standings(run).slice(0, 10);
    if (catalog.playsInArena(run.preset)) return arenaService.standings(run);
    if (!commands.hasScoreboard(run.preset)) return [];
    const loop = loops.get(installedAppId);
    const output = loop?.link
        ? await loop.link.server.say([commands.READ_SCORES])
        : await withServerContainer(ownerId, installedAppId, (server) =>
              server.say([commands.READ_SCORES])
          );
    return [...commands.readScores(output).entries()]
        .map(([name, score]) => ({ name, score }))
        .sort((left, right) => right.score - left.score)
        .slice(0, 10);
}

// ------------------------------------------------------------------ starting one

/**
 * Start an event: the countdown now, the event itself when it runs out.
 *
 * Refused while another is on, on Bedrock, with nobody on the server, and -
 * unless an operator pressed Run and said to go ahead anyway - with fewer
 * players actually playing than the settings ask for.
 */
export async function startEvent(input: {
    ownerId: string;
    installedAppId: string;
    presetId: string;
    trigger: stored.EventTrigger;
    startedBy: string | null;
}): Promise<stored.EventRun> {
    const row = await readRow(input.installedAppId);
    if (!row) throw new Error(refused("noServer"));
    if (editionOf(row.catalogId) === "bedrock") {
        throw new Error(refused("javaOnly"));
    }
    const config = settingsOf(row.config);
    const preset = config.presets.find((one) => one.id === input.presetId);
    if (!preset) throw new Error(gameMessage("minecraft", "events.problems.eventGone"));
    if (!preset.enabled && input.trigger !== "manual") throw new Error(refused("switchedOff"));

    const seen = await sample(row.ownerId, input.installedAppId);
    if (seen === null) throw new Error(refused("notRunning"));
    if (seen.size === 0) throw new Error(refused("nobodyOn"));
    // Its own minimum, counted on the server as it starts - or, for an event
    // players join, on who joined when the countdown ends.
    const fewest = catalog.minPlayersOf(preset);
    if (!catalog.takesJoiners(preset) && seen.size < fewest) {
        throw new Error(refused("tooFewPlayers", { count: seen.size, needed: fewest }));
    }
    // The chunks somebody already keeps loaded - a farm, a spawn - before the
    // event loads any: whatever it lets go of at the end, never these.
    const keepForced = await withServerContainer(
        row.ownerId,
        input.installedAppId,
        async (server) => chunks.readForced(await server.say([chunks.READ_FORCED]))
    ).catch(() => null);
    // The minimum is for events that start on their own. An operator who
    // presses Run has looked at who is on and decided.
    const active = plan.playersFor(preset, seen, config.settings.afkMinutes, Date.now()).length;
    const needed = catalog.activeNeeded(preset, config.settings);
    if (input.trigger !== "manual" && active < needed) {
        throw new Error(
            refused("tooFewActive", {
                active,
                count: seen.size,
                needed,
                overworld: catalog.needsOverworld(preset) ? "yes" : "no"
            })
        );
    }
    if (input.trigger !== "manual") {
        const busy = plan.busyReason(seen, config.settings.afkMinutes, Date.now());
        if (busy) throw new Error(refused("notNow", { reason: busy }));
    }
    // Peaceful takes every hostile mob away the moment it appears: a blood moon
    // with no mobs, a boss that is gone before anybody sees it.
    if (catalog.needsHostileMobs(preset)) {
        const peaceful = await withServerContainer(
            row.ownerId,
            input.installedAppId,
            async (server) => commands.isPeaceful(await server.say([commands.READ_DIFFICULTY]))
        ).catch(() => false);
        if (peaceful) {
            throw new Error(refused("peaceful"));
        }
    }
    // Players who cannot hurt each other have nothing to duel with. Read from
    // the server's own settings file, which is what the game goes by.
    if (catalog.needsPvp(preset)) {
        const properties = await withServerContainer(row.ownerId, input.installedAppId, (server) =>
            readContainerFile(server, SERVER_PROPERTIES)
        ).catch(() => null);
        if (properties !== null && parseProperties(properties).pvp === "false") {
            throw new Error(refused("pvpBlocked"));
        }
    }
    // The kit's marker, and what a dropped item remembers of who threw it, are
    // read the way 1.16 and later write them.
    if (catalog.playsInArena(preset)) {
        const recent = await withServerContainer(row.ownerId, input.installedAppId, (server) =>
            serverAtLeast(server, [1, 16])
        ).catch(() => null);
        if (recent === false) {
            throw new Error(
                refused("needsNewer", {
                    kind: gameMessage("minecraft", `events.kinds.${preset.kind}.label`)
                })
            );
        }
    }

    const now = Date.now();
    // Long enough to type `join` in, for an event players join.
    const countdown = catalog.countdownSecondsFor(preset, config.settings) * 1000;
    const run = {
        id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        trigger: input.trigger,
        startedBy: input.startedBy,
        preset,
        phase: "countdown" as const,
        createdAt: now,
        startsAt: now + countdown,
        endsAt: now + countdown + catalog.runMinutes(preset) * 60_000,
        participants: [...seen.values()].map((one) => one.name),
        place: null,
        target: null,
        placeTries: 0,
        placeFrom: null,
        placeLog: [],
        overSea: false,
        reveals: 0,
        round: -1,
        roundEndsAt: null,
        points: {},
        decidedBy: null,
        lastWaveAt: 0,
        closedAt: 0,
        cancelled: false,
        finishing: false,
        gamerules: {},
        timeBefore: null,
        offMode: [],
        keptOut: [],
        chests: [],
        held: [],
        hidden: false,
        origin: null,
        // A gathering's material is drawn as each round starts, never before:
        // told during the countdown, it had players waiting beside it.
        material: null,
        materials: [],
        survived: {},
        keepForced: keepForced ? [...keepForced] : null,
        chunks: [],
        meteors: [],
        landings: 0,
        stage: null,
        joined: [],
        enrolled: false,
        site: null,
        arena: null,
        entrants: [],
        sentOut: [],
        marker: null,
        kit: [],
        readyAt: null,
        tally: {},
        votes: {},
        theme: null,
        voting: false,
        doneOffered: false,
        done: [],
        buildEndsAt: null,
        boss: null
    } satisfies stored.EventRun;

    const stored = await updateEventState(input.installedAppId, (state) => {
        if (state.run) throw new Error(refused("anotherOn"));
        return { ...state, run, waiting: null };
    });
    if (!stored) throw new Error(refused("noServer"));
    startLoop(row.ownerId, input.installedAppId, run, config.settings);
    return run;
}

/** Call off the event on now. The loop takes it down on its next tick. */
export async function cancelEvent(ownerId: string, installedAppId: string): Promise<void> {
    const loop = loops.get(installedAppId);
    if (loop) {
        loop.run = { ...loop.run, cancelled: true };
    }
    const state = await updateEventState(installedAppId, (current) =>
        current.run ? { ...current, run: { ...current.run, cancelled: true } } : current
    );
    if (!state?.run) throw new Error(refused("noneOn"));
    if (!loop) {
        const row = await readRow(installedAppId);
        if (row) startLoop(ownerId, installedAppId, state.run, settingsOf(row.config).settings);
    }
}

/**
 * Skip what is left of the countdown: the event begins on the next tick and
 * still lasts its full time, since its end moves forward by the same amount.
 */
export async function startNow(ownerId: string, installedAppId: string): Promise<void> {
    const now = Date.now();
    const skipped = (run: stored.EventRun): stored.EventRun => {
        const early = Math.max(0, run.startsAt - now);
        return { ...run, startsAt: run.startsAt - early, endsAt: run.endsAt - early };
    };
    const state = await updateEventState(installedAppId, (current) =>
        current.run?.phase === "countdown" && !current.run.cancelled
            ? { ...current, run: skipped(current.run) }
            : current
    );
    if (!state?.run || state.run.cancelled) throw new Error(refused("noneOn"));
    if (state.run.phase !== "countdown") throw new Error(refused("alreadyStarted"));
    const loop = loops.get(installedAppId);
    if (loop) {
        if (loop.run.phase === "countdown") loop.run = skipped(loop.run);
        kick(installedAppId, loop);
    } else {
        const row = await readRow(installedAppId);
        if (row) startLoop(ownerId, installedAppId, state.run, settingsOf(row.config).settings);
    }
}

/** Stop waiting to hand somebody a prize. */
export async function forgetPending(installedAppId: string, pendingId: string): Promise<void> {
    await updateEventState(installedAppId, (state) => ({
        ...state,
        pending: state.pending.filter((one) => one.id !== pendingId)
    }));
}

/**
 * A player's things an event could not give back, tried again from their
 * barrels - or their database copy - now. Answers how it went.
 */
export async function retryStash(
    installedAppId: string,
    id: string
): Promise<stashService.GiveBack> {
    const row = await readRow(installedAppId);
    if (!row) throw new Error(refused("noServer"));
    return withServerContainer(row.ownerId, installedAppId, async (server) => {
        if (!server.running) return "offline" as const;
        return stashService.retryStash(server, installedAppId, id);
    });
}

/** Taken off the panel: the operator has dealt with it. The blocks a stash kept
 *  in barrels placed go with it, while the server is up to take them. */
export async function dismissStash(installedAppId: string, id: string): Promise<void> {
    const row = await readRow(installedAppId);
    if (!row) throw new Error(refused("noServer"));
    const done = await withServerContainer(row.ownerId, installedAppId, async (server) => {
        await stashService.dismissStash(server.running ? server : null, installedAppId, id);
        return true;
    }).catch(() => false);
    if (!done) await stashService.dismissStash(null, installedAppId, id);
}

// ------------------------------------------------------------------ the loop

/**
 * A tick now, unless one is already running - that one does it. The timer's way
 * in, and the way an action (Run, Start now) is answered at once instead of on
 * the next tick; never two at a time, so nothing is announced twice.
 */
function kick(installedAppId: string, loop: Loop): void {
    if (loop.busy || loop.finishing) return;
    loop.busy = true;
    void tick(installedAppId, loop)
        .catch((error: unknown) => {
            console.warn("polaris: event tick failed", installedAppId, String(error));
            // Opened again on the next tick: a server that restarted
            // took the connection with it.
            void dropLink(loop);
        })
        .finally(() => {
            loop.busy = false;
        });
}

function startLoop(
    ownerId: string,
    installedAppId: string,
    run: stored.EventRun,
    settings: catalog.EventSettings
): void {
    const running = loops.get(installedAppId);
    if (running) {
        if (!running.finishing) running.run = run;
        return;
    }
    if (run.finishing) return;
    const loop: Loop = {
        ownerId,
        timer: setInterval(() => kick(installedAppId, loop), TICK_MS),
        clock: null,
        quick: null,
        quickBusy: false,
        busy: false,
        run,
        link: null,
        ticks: 0,
        lastSample: 0,
        lastSave: Date.now(),
        finishing: false,
        logFrom: null,
        ground: null,
        sounded: new Set(),
        // Resumed after a restart: the countdown was already said.
        announced: run.phase === "running",
        language: speech.EVERY,
        home: settings.language,
        homeKnown: false,
        sawUnready: false,
        countdown: catalog.countdownSecondsFor(run.preset, settings),
        flavour: null,
        quiet: false,
        placeFloor: 0,
        homes: null
    };
    loop.timer.unref?.();
    loop.clock = setInterval(() => void showClock(loop), CLOCK_MS);
    loop.clock.unref?.();
    if (run.preset.kind === "parkour" || run.preset.kind === "team-duel") {
        loop.quick = setInterval(() => void quickLook(loop), QUICK_MS);
        loop.quick.unref?.();
    }
    loops.set(installedAppId, loop);
    // Said in the game at once, not a tick later.
    kick(installedAppId, loop);
    // Picked up again after a restart: the side of the screen is the event's
    // again, or the live panel would be drawn over its scoreboard.
    if (run.phase === "running" && commands.hasScoreboard(run.preset)) holdSidebar(installedAppId);
}

async function dropLink(loop: Loop): Promise<void> {
    const link = loop.link;
    loop.link = null;
    await link?.close().catch(() => undefined);
}

async function serverFor(installedAppId: string, loop: Loop): Promise<ServerContainer | null> {
    if (!loop.link) {
        const link = await openServerContainer(loop.ownerId, installedAppId);
        loop.link = {
            server: chunks.sparing(link.server, () => chunks.heldBefore(loop.run)),
            close: link.close
        };
    }
    return loop.link.server.running ? loop.link.server : null;
}

async function persist(installedAppId: string, loop: Loop): Promise<void> {
    const run = loop.run;
    await updateEventState(installedAppId, (state) =>
        state.run && state.run.id === run.id
            ? {
                  ...state,
                  run: {
                      ...run,
                      cancelled: state.run.cancelled || run.cancelled,
                      finishing: state.run.finishing || run.finishing
                  }
              }
            : state
    );
    loop.lastSave = Date.now();
}

async function tick(installedAppId: string, loop: Loop): Promise<void> {
    loop.ticks += 1;
    const now = Date.now();
    const run = loop.run;
    const server = await serverFor(installedAppId, loop).catch(() => null);
    if (!server) {
        if (now > run.endsAt + GIVE_UP_AFTER_MS || run.cancelled) {
            await finish(
                installedAppId,
                loop,
                null,
                "failed",
                "The server stopped during the event"
            );
        }
        return;
    }
    await hearPlayers(installedAppId, loop, server);
    if (run.cancelled) return finish(installedAppId, loop, server, "cancelled", "Called off");

    if (run.phase === "countdown") return countdown(installedAppId, loop, server, now);

    if (now - loop.lastSample >= SAMPLE_EVERY_MS) {
        loop.lastSample = now;
        const seen = await playing.lookAt(installedAppId, server);
        // Creative and spectator are noted as they are seen, not only at the
        // end: switching back for the last minute does not undo a rush mined
        // in creative.
        const offMode = commands
            .readWhere(await server.say([commands.NOT_SURVIVAL]))
            .map((one) => one.name);
        const noted = new Set(loop.run.offMode.map((name) => name.toLowerCase()));
        const fresh = offMode.filter((name) => !noted.has(name.toLowerCase()));
        if (fresh.length > 0) loop.run = { ...loop.run, offMode: [...loop.run.offMode, ...fresh] };
        const known = new Set(loop.run.participants.map((name) => name.toLowerCase()));
        const joined = [...seen.values()].filter((one) => !known.has(one.name.toLowerCase()));
        if (joined.length > 0) {
            loop.run = {
                ...loop.run,
                participants: [...loop.run.participants, ...joined.map((one) => one.name)]
            };
        }
    }

    let done: string | null;
    try {
        done = await play(installedAppId, loop, server, now);
    } catch (error) {
        if (error instanceof stageService.CalledOff || error instanceof arenaService.TooFew)
            return finish(installedAppId, loop, server, "cancelled", error.message);
        if (error instanceof PlaceNotFound || error instanceof arenaService.EventStopped)
            return finish(installedAppId, loop, server, "failed", error.message);
        if (error instanceof stageService.CalledOff)
            return finish(installedAppId, loop, server, "cancelled", error.message);
        throw error;
    }
    if (done) return finish(installedAppId, loop, server, "finished", done);
    if (loop.run.readyAt === null) {
        if (catalog.readyToPlay(loop.run)) await markReady(installedAppId, loop, Date.now());
        // Never playable in as long again as it was to last: given up.
        else if (now >= loop.run.endsAt + catalog.runMinutes(loop.run.preset) * 60_000)
            return finish(installedAppId, loop, server, "failed", "It could not get ready in time");
        else loop.sawUnready = true;
    } else if (now >= loop.run.endsAt)
        return finish(installedAppId, loop, server, "finished", "Ran its full time");
    if (now - loop.lastSave >= SAVE_EVERY_MS) await persist(installedAppId, loop);
}

/**
 * The event playable from now: its clock starts with the whole of its time
 * ahead - the place searched, the boss standing, everybody brought in all
 * before it, never out of it. Written down, and only ever once, so a restart
 * neither starts it again nor loses its end.
 */
async function markReady(installedAppId: string, loop: Loop, now: number): Promise<void> {
    if (loop.run.readyAt !== null) return;
    const planned = catalog.runMinutes(loop.run.preset) * 60_000;
    loop.run = loop.sawUnready
        ? { ...loop.run, readyAt: now, startsAt: now, endsAt: now + planned }
        : // Picked up after a restart already playable - it was being played
          // before this was written down: its clock stays as it was.
          { ...loop.run, readyAt: loop.run.startsAt };
    await persist(installedAppId, loop);
}

async function countdown(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    now: number
): Promise<void> {
    const { preset } = loop.run;
    const language = loop.language;
    const left = (loop.run.startsAt - now) / 1000;
    const title = preset.name;
    // Quietened first - one read and one write - so the announcement itself
    // does not flood the operators' chat.
    await quieten(installedAppId, loop, server);
    // No warning asked for: straight to the start, rather than "starts in 0:00".
    if (!loop.announced && loop.run.startsAt <= now) loop.announced = true;
    if (!loop.announced) {
        loop.announced = true;
        await server.sayAll([
            ...commands.barCreate(
                messages.startsInBar(title, left, language),
                commands.barColor(preset.kind)
            ),
            ...commands.titleCommands(messages.startsSoonTitle(language), `&e${title}`),
            // One line: when, and what to do.
            commands.say(
                messages.tag(language) +
                    messages.startsInWithRules(
                        title,
                        left,
                        messages.rules(preset.kind, language, rulesVariant(preset)),
                        language
                    )
            ),
            // A rare catch is told now, to give time to find a rod: the treasure is
            // caught anywhere there is water, so nobody gains a head start.
            ...targetLines(loop.run, language),
            ...(catalog.takesJoiners(preset)
                ? (() => {
                      const buttons = messages.joinButtonsText(language);
                      return [
                          ...commands.joinTriggerLines(),
                          commands.joinButtons(
                              messages.tag(language) + buttons.lead,
                              buttons.join,
                              buttons.leave
                          )
                      ];
                  })()
                : []),
            commands.sound(commands.SOUNDS.tick)
        ]);
    }
    if (now < loop.run.startsAt) {
        const lines: string[] = [];
        // Who has typed `join` so far, read off the chat.
        if (catalog.playsOnStage(preset))
            await stageService.countdownTick(loop, stageTools(installedAppId, loop, server), lines);
        if (catalog.playsInArena(preset)) {
            lines.push(
                ...(await arenaService.joinTick(kindContext(installedAppId, loop, server, now)))
            );
            if (left > 5) lines.push(arenaService.joinBar(loop.run, language));
        }
        // Who has joined, on the side panel for everybody to see.
        if (catalog.takesJoiners(preset)) {
            holdSidebar(installedAppId);
            const names = catalog.playsOnStage(preset)
                ? (loop.run.stage?.joined ?? [])
                : loop.run.joined;
            lines.push(
                ...commands.joinListLines(
                    messages.joinListTitle(preset.name, names.length, language),
                    names.filter((name) => catalog.PLAYER_NAME.test(name))
                )
            );
        }
        await server.sayAll(lines);
        return;
    }
    await begin(installedAppId, loop, server, now);
}

/**
 * The boss bar's clock, moved on every second on a timer of its own.
 *
 * Worked out as it is sent rather than when a tick began: a tick that spends
 * seconds looking for ground, or asking about many players, sent the time it
 * started with at its end - after a newer one - and the clock froze or went
 * back. The marks of the last seconds are sounded here too, so they are on time.
 * The boss's and a horde's bars show health and waves, and are left to them.
 */
/**
 * The quick look - parkour's falls and checkpoints (`stageService.quickLines`),
 * a duel's low players shielded (`duel.shieldLow`): one batch, nothing read,
 * never two at once, and nothing while the tick has no connection open.
 */
async function quickLook(loop: Loop): Promise<void> {
    const server = loop.link?.server;
    if (!server || loop.finishing || loop.quickBusy || loop.run.phase !== "running") return;
    const lines =
        loop.run.preset.kind === "team-duel"
            ? loop.run.readyAt === null
                ? []
                : [
                      duel.shieldLow(
                          (loop.run.preset.options as catalog.EventOptions<"team-duel">).downHearts
                      )
                  ]
            : stageService.quickLines(loop);
    if (lines.length === 0) return;
    loop.quickBusy = true;
    try {
        await server.sayAll(lines);
    } catch {
        // The tick finds a connection that went, and opens another.
    } finally {
        loop.quickBusy = false;
    }
}

async function showClock(loop: Loop): Promise<void> {
    const server = loop.link?.server;
    if (!server || loop.finishing || !loop.announced) return;
    const { preset } = loop.run;
    const now = Date.now();
    const lines: string[] = [];
    // The countdown over and the next tick not yet round to begin it: the
    // event's own time is already running, and is what the bar shows, rather
    // than the countdown's last second standing still until then.
    if (loop.run.phase === "countdown" && now < loop.run.startsAt) {
        const left = (loop.run.startsAt - now) / 1000;
        const max = Math.max(
            1,
            loop.countdown,
            catalog.takesJoiners(preset) ? catalog.JOIN_SECONDS : 0
        );
        lines.push(
            ...commands.barUpdate(messages.startsInBar(preset.name, left, loop.language), left, max)
        );
        const mark = Math.ceil(left);
        if ([30, 10, 5, 4, 3, 2, 1].includes(mark) && !loop.sounded.has(mark)) {
            loop.sounded.add(mark);
            lines.push(commands.sound(commands.SOUNDS.tick));
            if (mark <= 5) lines.push(`title @a actionbar ${commands.text(`&e${mark}`)}`);
        }
    } else if (loop.run.readyAt === null) {
        // Its time starts once it can be played - the place set up, the boss
        // standing, everybody brought in - so the clock waits full until then
        // instead of running down while nobody can play.
        lines.push(
            ...commands.barUpdate(messages.arenaGettingReady(preset.name, loop.language), 1, 1)
        );
    } else if (preset.kind === "gathering" && loop.run.roundEndsAt !== null) {
        // The round's own clock, and which round it is.
        const options = preset.options as catalog.EventOptions<"gathering">;
        const left = Math.min(loop.run.roundEndsAt, loop.run.endsAt) - now;
        if (left <= 0) return;
        lines.push(
            ...commands.barUpdate(
                messages.gatherRoundBar(
                    loop.run.round + 1,
                    options.rounds,
                    gather.materialOf(loop.run.material, options),
                    left / 1000,
                    loop.language
                ),
                left / 1000,
                options.roundMinutes * 60
            )
        );
    } else if (preset.kind !== "world-boss" && preset.kind !== "waves") {
        const left = (loop.run.endsAt - now) / 1000;
        if (left <= 0) return;
        const total = (loop.run.endsAt - loop.run.startsAt) / 1000;
        lines.push(...commands.barUpdate(messages.barName(preset.name, left), left, total));
    }
    if (lines.length > 0) await server.sayAll(lines).catch(() => undefined);
}

/**
 * Operators' chat kept clear of what the event's commands say, for as long as it
 * runs: the rule's value written down first - so whatever ends the event, even
 * after a restart, puts it back - and only then turned off.
 */
async function quieten(installedAppId: string, loop: Loop, server: ServerContainer): Promise<void> {
    if (loop.quiet) return;
    loop.quiet = true;
    for (const rule of commands.FEEDBACK_RULES) {
        const recorded = loop.run.gamerules[rule];
        const value =
            recorded ?? commands.readRuleValue(await server.say([commands.readRule(rule)]));
        if (value === null) continue;
        if (recorded === undefined) {
            loop.run = { ...loop.run, gamerules: { ...loop.run.gamerules, [rule]: value } };
            await persist(installedAppId, loop);
        }
        if (value === "true") await server.say([commands.setRule(rule, "false")]);
        return;
    }
}

/** What a rare catch is for, said with the rules; a gathering's material is
 *  said as each round starts (`gatheringRound`). */
function targetLines(run: stored.EventRun, language: speech.Speech): string[] {
    const { preset } = run;
    if (preset.kind === "rare-catch") {
        const { treasure } = preset.options as catalog.EventOptions<"rare-catch">;
        return [commands.say(messages.tag(language) + messages.catchTarget(treasure, language))];
    }
    return [];
}

/** Which way of an event's rules its options call for (`messages.rules`). */
function rulesVariant(preset: catalog.EventPreset): written.RulesVariant {
    if (preset.kind === "world-boss") {
        const options = preset.options as catalog.EventOptions<"world-boss">;
        return { arena: options.arena, finalBlow: options.winner === "final-blow" };
    }
    if (preset.kind === "waves")
        return { byDamage: (preset.options as catalog.EventOptions<"waves">).winner === "damage" };
    return { race: isRace(preset) };
}

function isRace(preset: catalog.EventPreset): boolean {
    return (
        preset.kind === "explorer" &&
        (preset.options as catalog.EventOptions<"explorer">).mode === "race"
    );
}

/** The start: the scoreboard up, the world changed where the event changes it. */
async function begin(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    now: number
): Promise<void> {
    const { preset } = loop.run;
    const language = loop.language;
    const seconds = (loop.run.endsAt - now) / 1000;
    if (commands.hasScoreboard(preset)) holdSidebar(installedAppId);
    // The list of who joined gives the panel back: to the event's own scoreboard,
    // or to the live panel when this event has none.
    if (catalog.takesJoiners(preset)) {
        await server.sayAll([commands.JOIN_LIST_OFF]);
        if (!commands.hasScoreboard(preset)) releaseSidebar(loop.ownerId, installedAppId);
    }
    const lines: string[] = [
        ...commands.barCreate(
            messages.barName(preset.name, seconds),
            commands.barColor(preset.kind)
        ),
        ...commands.setupScoreboard(preset, `&6&l${preset.name}`),
        ...commands.titleCommands(messages.startedTitle(language), `&e${preset.name}`),
        // One line: what it is, what to do, how long.
        commands.say(
            messages.tag(language) +
                messages.startLine(
                    preset.name,
                    messages.rules(preset.kind, language, rulesVariant(preset)),
                    catalog.runMinutes(preset),
                    language
                )
        ),
        ...targetLines(loop.run, language),
        commands.sound(preset.kind === "blood-moon" ? commands.SOUNDS.horn : commands.SOUNDS.start)
    ];
    if (preset.kind === "gathering") {
        // The first round, counted from now: what everybody holds at this
        // moment is where they start.
        lines.push(...(await gatheringRound(installedAppId, loop, now, 0)));
    }
    if (preset.kind === "rare-catch") {
        lines.push(...rareCatch.catchSetup(preset.options as catalog.EventOptions<"rare-catch">));
    }
    if (preset.kind === "xp-boost") {
        lines.push(...boost.boostSetup(preset.options as catalog.EventOptions<"xp-boost">));
    }
    if (preset.kind === "world-boss") {
        // The boss drawn, and the rules its fight holds written down before
        // they are changed, so whatever ends it - a restart included - puts
        // them back.
        const held = await bossService.begin(kindContext(installedAppId, loop, server, now));
        if (held.refused) return finish(installedAppId, loop, server, "failed", held.refused);
        lines.push(...held.lines);
    }
    if (catalog.summonsMobs(preset)) {
        // Nothing it brings up tramples a farm, breaks a door or blows a hole
        // in anybody's home: mob griefing off for exactly the event, written
        // down first so even a restart right after puts it back.
        const before: Record<string, string> = {};
        for (const rule of commands.GRIEF_RULES) {
            const value = commands.readRuleValue(await server.say([commands.readRule(rule)]));
            if (value === null) continue;
            before[rule] = value;
            break;
        }
        loop.run = { ...loop.run, gamerules: { ...before, ...loop.run.gamerules } };
        await persist(installedAppId, loop);
        lines.push(...Object.keys(before).map((rule) => commands.setRule(rule, "false")));
    }
    if (preset.kind === "blood-moon") {
        // Held still until dawn: the clock, or the night runs out before the
        // event does or is slept through; the weather, or the rain clears.
        // What each was is kept, and put back when it ends.
        const before: Record<string, string> = {};
        for (const names of commands.FROZEN_RULES) {
            for (const rule of names) {
                const value = commands.readRuleValue(await server.say([commands.readRule(rule)]));
                if (value === null) continue;
                before[rule] = value;
                lines.push(commands.setRule(rule, "false"));
                break;
            }
        }
        const timeBefore =
            commands.readDaytime(await server.say([commands.READ_DAYTIME])) ??
            commands.readDaytime(await server.say([commands.READ_DAY_TIMELINE]));
        loop.run = {
            ...loop.run,
            gamerules: { ...before, ...loop.run.gamerules },
            timeBefore: loop.run.timeBefore ?? timeBefore
        };
        lines.push(...commands.nightfall(seconds));
    }
    if (preset.kind === "happy-hour") {
        lines.push(
            ...commands.happyEffects(preset.options as catalog.EventOptions<"happy-hour">, seconds)
        );
    }
    if (preset.kind === "waves") {
        // Nobody loses what they carry to a wave: keepInventory on for
        // exactly the event. What it was is written down before it is
        // changed, so even a restart right after puts it back.
        const before: Record<string, string> = {};
        for (const rule of waves.KEEP_INVENTORY) {
            const value = commands.readRuleValue(await server.say([commands.readRule(rule)]));
            if (value === null) continue;
            before[rule] = value;
            break;
        }
        loop.run = { ...loop.run, gamerules: { ...before, ...loop.run.gamerules } };
        await persist(installedAppId, loop);
        lines.push(
            ...Object.keys(before).map((rule) => commands.setRule(rule, "true")),
            ...waves.wavesSetup((preset.options as catalog.EventOptions<"waves">).mix)
        );
    }
    if (preset.kind === "meteor-shower") {
        lines.push(
            ...meteors.meteorSetup((preset.options as catalog.EventOptions<"meteor-shower">).ores)
        );
    }
    if (catalog.playsInArena(preset)) lines.push(...arenaService.beginLines(preset, loop.home));
    const needs = catalog.worldNeeds(preset);
    if (preset.kind !== "blood-moon" && (needs.time || needs.weather)) {
        // What it needs of the world - a time of day, a weather - held still for
        // as long as it runs: what each rule was, and the time of day, written
        // down before they are changed, so whatever ends it - a restart
        // included - puts back exactly that.
        const before: Record<string, string> = {};
        for (const names of commands.worldRules(needs)) {
            for (const rule of names) {
                const value =
                    loop.run.gamerules[rule] ??
                    commands.readRuleValue(await server.say([commands.readRule(rule)]));
                if (value === null) continue;
                before[rule] = value;
                lines.push(commands.setRule(rule, "false"));
                break;
            }
        }
        const timeBefore = needs.time
            ? (commands.readDaytime(await server.say([commands.READ_DAYTIME])) ??
              commands.readDaytime(await server.say([commands.READ_DAY_TIMELINE])))
            : null;
        loop.run = {
            ...loop.run,
            gamerules: { ...before, ...loop.run.gamerules },
            timeBefore: loop.run.timeBefore ?? timeBefore
        };
        await persist(installedAppId, loop);
        lines.push(...commands.worldLines(needs, seconds));
    }
    if (catalog.takesJoiners(preset)) {
        // Nobody loses what they carry to a fight or a fall: a death keeps all
        // of it, for exactly as long as the event lasts - through everybody
        // being sent home and coming down - and the rule is put back after.
        const before: Record<string, string> = {};
        for (const rule of duel.KEEP_INVENTORY) {
            const value = commands.readRuleValue(await server.say([commands.readRule(rule)]));
            if (value === null) continue;
            before[rule] = value;
            lines.push(commands.setRule(rule, "true"));
            break;
        }
        // A rule it cannot read is one it cannot hold or give back: no fight.
        if (Object.keys(before).length === 0 && catalog.needsPvp(preset)) {
            return finish(
                installedAppId,
                loop,
                server,
                "failed",
                "The server would not say whether it keeps inventories, so the duel could not promise nobody loses anything"
            );
        }
        loop.run = { ...loop.run, gamerules: { ...before, ...loop.run.gamerules } };
        await persist(installedAppId, loop);
    }
    await server.sayAll(lines);
    loop.run = { ...loop.run, phase: "running", startsAt: now };
    // Its clock starts now if there is nothing to set up first, and when there
    // is, once it has been.
    loop.sawUnready = true;
    if (catalog.readyToPlay(loop.run)) await markReady(installedAppId, loop, now);
    else await persist(installedAppId, loop);
}

/**
 * One tick of the event itself. Answers a sentence when it is decided before
 * its time is up - the chest found, the boss down, the last round played - and
 * null while it goes on.
 */
async function play(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    now: number
): Promise<string | null> {
    const { preset } = loop.run;
    const left = (loop.run.endsAt - now) / 1000;
    const lines: string[] = [];

    // The boss bar's clock is `showClock`'s, a second at a time; the boss's
    // shows its health and a horde defense's the wave.
    // Every other tick: the game adds the statistics up faster than anybody
    // reads a leaderboard, and it keeps the batch sent to the server small.
    if (loop.ticks % 2 === 0) lines.push(...commands.scoreTick(preset));

    let decided: string | null = null;
    switch (preset.kind) {
        case "blood-moon": {
            if (now - loop.run.lastWaveAt >= commands.WAVE_EVERY_MS) {
                const number = Math.floor((now - loop.run.startsAt) / commands.WAVE_EVERY_MS);
                lines.push(
                    ...commands.wave(preset.options as catalog.EventOptions<"blood-moon">, number)
                );
                loop.run = { ...loop.run, lastWaveAt: now };
            }
            break;
        }
        case "happy-hour": {
            // Again every half minute, for whoever joined since.
            if (loop.ticks % 15 === 0) {
                lines.push(
                    ...commands.happyEffects(
                        preset.options as catalog.EventOptions<"happy-hour">,
                        left
                    )
                );
            }
            break;
        }
        case "supply-drop":
            decided = await supplyDrop(installedAppId, loop, server, now, lines);
            break;
        case "world-boss":
            decided = await bossService.tick(kindContext(installedAppId, loop, server, now), lines);
            break;
        case "king-of-the-hill":
            // With fists only it is played in an arena of its own (`kinds/hill`).
            decided = catalog.hillFistsOnly(preset)
                ? await arenaService.arenaTick(
                      kindContext(installedAppId, loop, server, now),
                      lines
                  )
                : await hillService.walkInTick(
                      kindContext(installedAppId, loop, server, now),
                      TICK_MS / 1000,
                      lines
                  );
            break;
        case "explorer":
            if (isRace(preset)) decided = await race(installedAppId, loop, server, lines);
            break;
        case "trivia":
            decided = await triviaTick(installedAppId, loop, server, now, lines);
            break;
        case "treasure-hunt":
            decided = await treasureHunt(installedAppId, loop, server, lines);
            break;
        case "gathering":
            await gathering(installedAppId, loop, server, now, lines);
            break;
        case "rare-catch":
            decided = await rareCatchTick(loop, server, lines);
            break;
        case "xp-boost": {
            const options = preset.options as catalog.EventOptions<"xp-boost">;
            if (loop.ticks % 2 === 0) lines.push(...boost.boostTick(options));
            lines.push(
                `title @a actionbar ${commands.text(
                    messages.boostBar(options.perKill, options.perOre, loop.language)
                )}`
            );
            break;
        }
        case "waves":
            decided = await hordeDefense(installedAppId, loop, server, now, lines);
            break;
        case "meteor-shower":
            decided = await meteorShower(installedAppId, loop, server, now, lines);
            break;
        case "parkour":
        case "spleef":
            decided = await stageService.stageTick(
                loop,
                server,
                stageTools(installedAppId, loop, server),
                now,
                lines
            );
            break;
        case "team-duel":
        case "build-battle":
            decided = await arenaService.arenaTick(
                kindContext(installedAppId, loop, server, now),
                lines
            );
            break;
        default:
            break;
    }
    if (lines.length > 0) await server.sayAll(lines);
    return decided;
}

// ------------------------------------------------------------------ finding a place

/**
 * Somewhere for the event to happen, found over a few ticks: a point chosen,
 * its chunk loaded, a marker dropped onto the surface there. Answers the point
 * once it is found.
 *
 * Nowhere that is somebody's, and nowhere nobody can get to: not near where any
 * player online sleeps, not in water, and - over the whole of `radius` - only on
 * ground the world made, flat enough to walk across. A place that fails any of
 * it is given up and another tried. The one exception is the fixed point an
 * operator chose, taken as given on the first try.
 */
async function findPlace(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    place: catalog.EventPlace,
    distance: number,
    radius: number,
    /** How far from every bed; further for what should not come near a home. */
    clearance = commands.HOME_CLEARANCE,
    /** Whether a fixed point is where it happens, or only where to look round
     *  - for an event of many places, which must not all be the one spot. */
    asGiven = true,
    how: PlaceHow = {}
): Promise<stored.Point | "failed" | null> {
    const chosen = asGiven && place.mode === "fixed" && loop.run.placeTries === 0;
    // A search come in near a home before starts where that one found its place.
    if (how.nearHome && !chosen && !loop.run.target && loop.run.placeTries < loop.placeFloor)
        loop.run = { ...loop.run, placeTries: loop.placeFloor };
    const limit = placeLimit(loop, how.nearHome === true);
    if (!loop.run.target) {
        const center = await centerFor(server, place);
        // Everybody in the Nether or the End: nobody to hold it near, said so.
        if (!center) throw new PlaceNotFound(NOBODY_IN_OVERWORLD);
        loop.run = { ...loop.run, placeFrom: center };
        let point: { x: number; z: number } | null = center;
        if (!chosen) {
            const homes = await homesOf(loop, server);
            // Nothing further out would do - the players live on an island, say:
            // an event that changes nothing and brings nothing hostile comes in
            // closer, halving the distance each try, and nearer a home.
            const look = commands.searchReach(
                distance,
                radius,
                loop.run.placeTries,
                how.nearHome === true,
                clearance,
                NEAR_AFTER
            );
            point = commands.clearPoint(
                center,
                look.reach,
                homes,
                Math.random,
                look.clearance,
                // Each its own way while there is room; come in to an island,
                // whichever way there is ground.
                loop.run.placeTries < NEAR_AFTER ? (how.bearing ?? null) : null
            );
        }
        if (!point) {
            loop.run = {
                ...noted(loop, center.x, center.z, "homes"),
                placeTries: loop.run.placeTries + 1
            };
            await persist(installedAppId, loop);
            return loop.run.placeTries >= limit ? "failed" : null;
        }
        // Written down before the chunk is loaded, so whatever ends the event
        // knows which one to let go of.
        loop.run = { ...loop.run, target: { x: point.x, z: point.z } };
        await persist(installedAppId, loop);
        await server.sayAll([commands.forceload(point.x, point.z)]);
        // Judged at once: the ground there is loaded by asking about it.
    }
    const { x, z } = loop.run.target!;
    const air = how.surface === "air";
    const dropped = await dropMark(server, x, z);
    // In the air: over the highest thing in the whole footprint, however tall
    // a build or a tree there is; the arena itself proves its air empty.
    const top = dropped && air ? await footprintTop(server, dropped, radius) : null;
    const point =
        dropped && air
            ? { ...dropped, y: Math.max(dropped.y, top ?? dropped.y) + (how.lift ?? 0) }
            : dropped;
    // Across the water from where the players are: they live on an island, and
    // nothing further out will do - the next try comes in at once.
    const walkable =
        air || !how.walkFrom || !point || (await canWalk(server, how.walkFrom, point));
    if (!walkable && how.nearHome)
        loop.run = { ...loop.run, placeTries: Math.max(loop.run.placeTries, NEAR_AFTER - 1) };
    const refused: search.PlaceRefusal | null =
        !point || chosen || air
            ? null
            : !walkable
              ? "water"
              : await siteIsOpen(
                    loop,
                    server,
                    point,
                    radius,
                    how.surface === "open" ? "open" : "ground"
                );
    const why: search.PlaceRefusal = refused ?? "noGround";
    if (point && !refused) {
        // The marker can come down a block or two from the column tried - an
        // older server spreads it - and so in the next chunk: that chunk is
        // the one held from now on, and the one tried let go of.
        const moved = !commands.sameChunk(point, { x, z });
        if (moved) await server.sayAll([commands.forceload(point.x, point.z)]);
        loop.run = { ...loop.run, place: point, target: { x: point.x, z: point.z } };
        await persist(installedAppId, loop);
        if (moved) await server.sayAll([commands.forceloadRemove(x, z)]);
        if (how.nearHome && !chosen)
            loop.placeFloor = Math.min(loop.run.placeTries, PLACE_TRIES - 2);
        return point;
    }
    await server.sayAll([
        commands.CLEAR_MARK,
        commands.forceloadRemove(x, z),
        // Judging the ground holds the chunk the marker came down in, which
        // need not be the column's.
        ...(point && !commands.sameChunk(point, { x, z })
            ? [commands.forceloadRemove(point.x, point.z)]
            : [])
    ]);
    loop.run = { ...noted(loop, x, z, why), target: null, placeTries: loop.run.placeTries + 1 };
    await persist(installedAppId, loop);
    return loop.run.placeTries >= limit ? "failed" : null;
}

/**
 * The top of the highest thing over a footprint - roofs, crowns, the sea - read
 * from a marker on top of each of its columns, all summoned and read at once.
 * Null on a server too old for the heightmap (before 1.19.4), where the arena's
 * own proof that its air is empty is what keeps it off anything.
 */
async function footprintTop(
    server: ServerContainer,
    center: stored.Point,
    radius: number
): Promise<number | null> {
    const reach = radius + 1;
    const area = `${center.x - reach} ${center.z - reach} ${center.x + reach} ${center.z + reach}`;
    try {
        await server.sayAll([
            `execute in minecraft:overworld run forceload add ${area}`,
            ...commands.topLines(commands.footprintColumns(center, radius))
        ]);
        return commands.highestTop(commands.samplesIn(await server.say([commands.READ_SAMPLES])));
    } finally {
        await server.sayAll([
            commands.CLEAR_SAMPLES,
            `execute in minecraft:overworld run forceload remove ${area}`,
            commands.forceload(center.x, center.z)
        ]);
    }
}

/** Whether a place can be walked to from a point (`commands.walkable`), judged
 *  by markers along the way, all summoned and read at once. */
async function canWalk(
    server: ServerContainer,
    from: { x: number; z: number },
    to: stored.Point
): Promise<boolean> {
    try {
        await server.sayAll(commands.pathLines(from, to));
        const path = commands.readWhere(await server.say([commands.READ_PATH]));
        const wet = commands.readWhere(await server.say([commands.READ_PATH_WET]));
        return commands.walkable(from, path, wet, to);
    } finally {
        await server.sayAll([commands.CLEAR_PATH]);
    }
}

/** Where players online sleep, as `commands.readHomes` reads them: asked once a
 *  search, and kept that long - nobody moves their bed between two tries. */
async function homesOf(loop: Loop, server: ServerContainer): Promise<{ x: number; z: number }[]> {
    if (loop.homes && Date.now() - loop.homes.at < HOMES_KEPT_MS) return loop.homes.list;
    const [spawnX, spawnZ, respawn, spawnWorld, respawnWorld] = await Promise.all(
        commands.HOMES.map((line) => server.say([line]).catch(() => ""))
    );
    const list = commands.readHomes(
        spawnX ?? "",
        spawnZ ?? "",
        respawn ?? "",
        spawnWorld ?? "",
        respawnWorld ?? ""
    );
    loop.homes = { at: Date.now(), list };
    return list;
}

/**
 * Whether the ground over the whole of a place is the world's own and walkable:
 * every sampled column dry, within a few blocks of the center's height, and on
 * nothing anybody built. Answers null when it is, and what is in the way when it
 * is not. Leaves the marker back on the center, where whatever the event puts
 * down is put.
 *
 * Every column is judged at once - a marker summoned onto each, and each
 * question asked of all of them in one command - which is a handful of trips to
 * the server where one column at a time took five or six each. A server too old
 * for the heightmap that needs (before 1.19.4) is judged a column at a time.
 */
async function siteIsOpen(
    loop: Loop,
    server: ServerContainer,
    center: stored.Point,
    radius: number,
    /** `open` for what is built in the air: open water under it is as good as land. */
    surface: "ground" | "open" = "ground"
): Promise<search.PlaceRefusal | null> {
    const reach = radius + 1;
    const area = `${center.x - reach} ${center.z - reach} ${center.x + reach} ${center.z + reach}`;
    await server.sayAll([`execute in minecraft:overworld run forceload add ${area}`]);
    try {
        const samples = commands.siteSamples(center, radius);
        const judged = await judgeAtOnce(loop, server, center, samples, surface);
        return judged
            ? judged.refused
            : await judgeOneByOne(loop, server, center, samples, surface);
    } finally {
        // The area let go, and the center's own chunk held again as before.
        await server.sayAll([
            commands.CLEAR_SAMPLES,
            `execute in minecraft:overworld run forceload remove ${area}`,
            commands.forceload(center.x, center.z)
        ]);
        await dropMark(server, center.x, center.z);
    }
}

/** What one column of a place was found to be: `water` is open water where
 *  that is as good as land, `sea` where it is not. */
type Column = "fine" | "rough" | "water" | "sea" | "built";

/** The verdict on a place from its columns, the center's first: open (null)
 *  while no column is built on, the center is fine, and no more than a quarter
 *  are rough; otherwise what is in the way. */
function verdict(columns: readonly Column[]): search.PlaceRefusal | null {
    if (columns.some((one) => one === "built")) return "built";
    if (columns.some((one) => one === "sea")) return "water";
    if (columns[0] === "rough") return "uneven";
    const rough = columns.filter((one) => one === "rough").length;
    return rough <= commands.roughAllowed(columns.length) ? null : "uneven";
}

/**
 * Every column judged in a few commands (`commands.sampleLines`): what is in the
 * way, or null when nothing is. Null in place of an answer when the server would
 * not put the markers down - older than the heightmap - or would not say what is
 * under them, for the column-at-a-time judging instead.
 */
async function judgeAtOnce(
    loop: Loop,
    server: ServerContainer,
    center: stored.Point,
    samples: readonly { x: number; z: number }[],
    surface: "ground" | "open"
): Promise<{ refused: search.PlaceRefusal | null } | null> {
    await server.sayAll(commands.sampleLines(samples));
    const down = commands.samplesIn(await server.say([commands.READ_SAMPLES]));
    if (down.length === 0) return null;
    const key = (one: { x: number; z: number }) => `${one.x},${one.z}`;
    const at = new Map(down.map((one) => [key(one), one]));
    const read = async (line: string) =>
        new Set(commands.samplesIn(await server.say([line])).map(key));
    const built = await builtAtOnce(loop, server);
    if (built === null) return null;
    const water =
        surface === "open" || built.size > 0
            ? await read(commands.SAMPLES_ON_WATER)
            : new Set<string>();
    const trees = new Set<string>();
    if (built.size > 0)
        for (const line of commands.SAMPLES_ON_TREES)
            for (const one of await read(line)) trees.add(one);
    const columns = samples.map((sample): Column => {
        const ground = at.get(key(sample));
        // No marker: water or lava, where the heightmap is no ground at all.
        if (!ground) return "rough";
        const level = Math.abs(ground.y - center.y) <= commands.SITE_STEP;
        if (level && surface === "open" && water.has(key(sample))) return "water";
        if (built.has(key(sample)) && water.has(key(sample))) return "sea";
        // A tree is rough ground; anything else - a build, water - is not
        // somewhere to put anything.
        if (built.has(key(sample))) return trees.has(key(sample)) ? "rough" : "built";
        return level ? "fine" : "rough";
    });
    return { refused: verdict(columns) };
}

/** The ground names this server was last found to know, kept across events:
 *  asking the newest list first cost a refused command on every place tried.
 *  Asked again after `GROUND_NAMES_MS`, so a server updated since is judged by
 *  the names it knows now. */
const groundNamesOf = new Map<string, { at: number; names: commands.GroundNames | "none" }>();
const GROUND_NAMES_MS = 30 * 60_000;

function knownGroundNames(installedAppId: string): commands.GroundNames | "none" | null {
    const known = groundNamesOf.get(installedAppId);
    if (!known) return null;
    if (Date.now() - known.at < GROUND_NAMES_MS) return known.names;
    groundNamesOf.delete(installedAppId);
    return null;
}

/**
 * The markers standing on something somebody built, by column; null when the
 * server would not say - every list of names refused, or a column not loaded.
 */
async function builtAtOnce(loop: Loop, server: ServerContainer): Promise<Set<string> | null> {
    loop.ground ??= knownGroundNames(server.installedAppId);
    while (loop.ground !== "none") {
        const names = loop.ground ?? commands.GROUND_NAMES[0];
        // Built on: in the answer of every line.
        const answers: Set<string>[] = [];
        let refused = false;
        for (const line of commands.builtUnderSamples(names)) {
            const output = await server.say([line]);
            if (commands.nameRefused(output)) {
                refused = true;
                break;
            }
            if (/not loaded/i.test(output)) return null;
            const found = new Set(commands.samplesIn(output).map((one) => `${one.x},${one.z}`));
            answers.push(found);
            if (found.size === 0) break;
        }
        if (refused) {
            loop.ground = commands.GROUND_NAMES[commands.GROUND_NAMES.indexOf(names) + 1] ?? "none";
            groundNamesOf.set(server.installedAppId, { at: Date.now(), names: loop.ground });
            continue;
        }
        loop.ground = names;
        groundNamesOf.set(server.installedAppId, { at: Date.now(), names });
        const [first, ...rest] = answers;
        return new Set([...(first ?? [])].filter((one) => rest.every((set) => set.has(one))));
    }
    return null;
}

/** Every column judged one at a time, as a server without the heightmap needs. */
async function judgeOneByOne(
    loop: Loop,
    server: ServerContainer,
    center: stored.Point,
    samples: readonly { x: number; z: number }[],
    surface: "ground" | "open"
): Promise<search.PlaceRefusal | null> {
    let rough = 0;
    for (const [index, sample] of samples.entries()) {
        const ground = await dropMark(server, sample.x, sample.z);
        // Water or lava where the game would not put the marker down: never
        // somewhere to stand, and never allowed at the center.
        let fine = ground !== null && Math.abs(ground.y - center.y) <= commands.SITE_STEP;
        if (
            fine &&
            ground &&
            surface === "open" &&
            commands.readTest(await server.say([commands.waterUnder(ground)])) === "passed"
        )
            continue;
        if (ground && (await builtOn(loop, server, ground)) === true) {
            // A tree is rough ground; anything else - a build, water - is not
            // somewhere to put anything.
            let tree = false;
            for (const line of commands.treeUnder(ground)) {
                if (commands.readTest(await server.say([line])) === "passed") tree = true;
            }
            if (!tree)
                return commands.readTest(await server.say([commands.waterUnder(ground)])) ===
                    "passed"
                    ? "water"
                    : "built";
            fine = false;
        }
        if (fine) continue;
        rough += 1;
        if (index === 0 || rough > commands.roughAllowed(samples.length))
            return ground === null ? "water" : "uneven";
    }
    return null;
}

/**
 * The marker on the ground at a column, under any trees - summoned there in one
 * line from 1.19.4; on an older server, wherever `spreadplayers` puts it and
 * then down through any crown. Answers where it came down, or null.
 */
async function dropMark(
    server: ServerContainer,
    x: number,
    z: number
): Promise<stored.Point | null> {
    await server.sayAll([commands.CLEAR_MARK, commands.summonOnGround(x, z)]);
    const down = commands.readPoint(await server.say([commands.READ_MARK]));
    if (down) return down;
    let output = "";
    for (const line of commands.markSurface(x, z)) output = await server.say([line]);
    if (!commands.spreadWorked(output)) return null;
    // Down through the crown and the trunk to the ground under them.
    await server.sayAll(commands.SETTLE_MARK);
    return commands.readPoint(await server.say([commands.READ_MARK]));
}
/**
 * Whether a column stands on something somebody built. Null when the server
 * refuses a name in every list of ground names, and so cannot be asked. An
 * answer that is neither - a column not loaded yet, a reply that never came -
 * counts as built, so the place is given up rather than guessed at, and nothing
 * about the server's names is taken from it.
 */
async function builtOn(
    loop: Loop,
    server: ServerContainer,
    point: stored.Point
): Promise<boolean | null> {
    while (loop.ground !== "none") {
        const names = loop.ground ?? commands.GROUND_NAMES[0];
        const answer = await groundAnswer(server, point, names);
        if (answer === "refused") {
            loop.ground = commands.GROUND_NAMES[commands.GROUND_NAMES.indexOf(names) + 1] ?? "none";
            continue;
        }
        if (answer !== "passed" && answer !== "failed") return true;
        loop.ground = names;
        return answer === "passed";
    }
    return null;
}

/** One list of ground names asked about a column, a command at a time. */
async function groundAnswer(
    server: ServerContainer,
    point: stored.Point,
    names: commands.GroundNames
): Promise<"passed" | "failed" | "refused" | "unsure"> {
    for (const line of commands.builtUnder(point, names)) {
        const output = await server.say([line]);
        const answer = commands.readTest(output);
        if (answer === "failed") return "failed";
        if (answer === "passed") continue;
        if (commands.nameRefused(output)) return "refused";
        // A chain of conditions answers nothing at all when one of them does not
        // hold - only a chain that holds all the way says "Test passed". Silence
        // is therefore "this is one of the world's own blocks", not a reply that
        // never came.
        if (commands.silent(output)) return "failed";
        return "unsure";
    }
    return "passed";
}

/** A place that was found and then would not take what was put there: undone,
 *  and another looked for, within the same number of tries. */
async function retryPlace(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    point: stored.Point,
    nearHome: boolean,
    why: search.PlaceRefusal = "occupied"
): Promise<void> {
    await server.sayAll([commands.CLEAR_MARK, ...commands.release(point, loop.run.target)]);
    loop.run = {
        ...noted(loop, point.x, point.z, why),
        place: null,
        target: null,
        placeTries: loop.run.placeTries + 1
    };
    await persist(installedAppId, loop);
    if (loop.run.placeTries >= placeLimit(loop, nearHome)) {
        const inAir =
            catalog.playsInArena(loop.run.preset) || catalog.playsOnStage(loop.run.preset);
        throw new PlaceNotFound(inAir ? NO_AIR : NO_GROUND);
    }
}

/** Where a walk to an event's place starts: the fixed point, or where most
 *  players in the Overworld are together (`hunt.centerOf`). */
async function walkStart(
    server: ServerContainer,
    place: catalog.EventPlace
): Promise<{ x: number; z: number } | undefined> {
    if (place.mode === "fixed") return { x: place.x, z: place.z };
    return (
        hunt.centerOf(commands.readWhere(await server.say([commands.IN_OVERWORLD]))) ?? undefined
    );
}

/** Where to look from: the fixed point, or one of the players in the Overworld. */
async function centerFor(
    server: ServerContainer,
    place: catalog.EventPlace
): Promise<{ x: number; z: number; near: string | null } | null> {
    if (place.mode === "fixed") return { x: place.x, z: place.z, near: null };
    const here = commands.readWhere(await server.say([commands.IN_OVERWORLD]));
    if (here.length === 0) return null;
    const one = here[Math.floor(Math.random() * here.length)]!;
    return { x: Math.round(one.x), z: Math.round(one.z), near: one.name };
}

/** One try that would not do, written into the run for the history (`place-search`). */
function noted(loop: Loop, x: number, z: number, why: search.PlaceRefusal): stored.EventRun {
    return { ...loop.run, placeLog: search.withTry(loop.run.placeLog, { x, z, why }) };
}

// ------------------------------------------------------------------ each kind

/** What an event players join is lent for one tick: the loop's own tools. */
function kindContext(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    now: number
): arenaService.KindContext {
    let nearHomeLast = false;
    return {
        server,
        language: loop.language,
        home: loop.home,
        now,
        get run() {
            return loop.run;
        },
        set run(next: stored.EventRun) {
            loop.run = next;
        },
        persist: () => persist(installedAppId, loop),
        findPlace: (place, distance, radius, surface, nearHome, lift) => {
            nearHomeLast = nearHome === true;
            return findPlace(
                installedAppId,
                loop,
                server,
                place,
                distance,
                radius,
                commands.HOME_CLEARANCE,
                true,
                {
                    surface: surface ?? "ground",
                    nearHome: nearHomeLast,
                    lift
                }
            );
        },
        giveUpPlace: (point, why) =>
            retryPlace(installedAppId, loop, server, point, nearHomeLast, why),
        chat: () => chatSince(loop, server),
        atLeast: (wanted) => serverAtLeast(server, wanted),
        stashOwner: { installedAppId, runId: loop.run.id, event: loop.run.preset.name },
        tickSeconds: TICK_MS / 1000,
        owed: async () => {
            const row = await readRow(installedAppId);
            return row ? owedNames(stored.readEventState(row.config)) : new Set<string>();
        }
    };
}

/**
 * Who, in lower case, is still owed a trip back from an earlier stage or arena
 * - logged out inside it - and so is not taken anywhere else until they are
 * back where they started.
 */
function owedNames(state: stored.EventState): Set<string> {
    return new Set([
        ...arenaService.owedNames(state.arenaLeftovers),
        ...state.stageLeftovers.flatMap((one) => one.saved.map((saved) => saved.name.toLowerCase()))
    ]);
}

/**
 * What was said in the chat since this was last asked, line by line. Null the
 * first time after the loop started - or started again after a restart - which
 * only marks where the log is: what was said while nobody was reading is not
 * taken.
 */
async function chatSince(
    loop: Loop,
    server: ServerContainer
): Promise<{ name: string; text: string }[] | null> {
    const said = await newChat(server, loop);
    return said === null ? null : chatLines(said);
}

async function supplyDrop(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    now: number,
    lines: string[]
): Promise<string | null> {
    const options = loop.run.preset.options as catalog.EventOptions<"supply-drop">;
    const language = loop.language;
    let place = loop.run.place;
    if (!place) {
        const found = await findPlace(
            installedAppId,
            loop,
            server,
            options.place,
            options.distance,
            SPOT_RADIUS,
            commands.HOME_CLEARANCE,
            true,
            // A chest changes nothing: on an island it comes in to the island.
            { nearHome: true }
        );
        if (found === "failed") throw new PlaceNotFound();
        if (!found) return null;
        await server.sayAll([commands.placeChest(found, options.loot), commands.CLEAR_MARK]);
        // Placed, and unopened: a protected area or a plugin that refused the
        // block would otherwise read as a chest somebody already opened.
        if ((await chestTest(server, found)) !== "passed") {
            await retryPlace(installedAppId, loop, server, found, true);
            return null;
        }
        place = found;
    }
    // Where it is, told in three steps across the event.
    const share = (now - loop.run.startsAt) / Math.max(1, loop.run.endsAt - loop.run.startsAt);
    const due = share >= 2 / 3 ? 3 : share >= 1 / 3 ? 2 : 1;
    if (loop.run.reveals < due) {
        const step = commands.REVEAL_STEPS[due - 1] ?? 0;
        lines.push(
            commands.say(
                messages.tag(language) +
                    (step === 0
                        ? messages.dropExact(place.x, place.y, place.z, language)
                        : messages.dropArea(
                              commands.roughly(place.x, step),
                              commands.roughly(place.z, step),
                              step,
                              language
                          ))
            ),
            commands.sound(commands.SOUNDS.tick)
        );
        loop.run = { ...loop.run, reveals: due };
        await persist(installedAppId, loop);
    }
    lines.push(commands.beam(place));
    const answer = await chestTest(server, place);
    if (answer !== "failed") return null;
    const opener =
        commands.readWhere(await server.say([commands.nearest(place, 8)]))[0]?.name ?? null;
    loop.run = { ...loop.run, decidedBy: opener };
    lines.push(commands.say(messages.tag(language) + messages.dropFound(opener ?? "?", language)));
    return opener ? `Found by ${opener}` : "Opened";
}

async function race(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    lines: string[]
): Promise<string | null> {
    const options = loop.run.preset.options as catalog.EventOptions<"explorer">;
    if (!loop.run.place) {
        // A finish line needs no ground to stand on: only the column is checked.
        const center = await centerFor(server, options.place);
        if (!center) throw new PlaceNotFound();
        const point = commands.pointAway(center, options.distance, Math.random);
        loop.run = { ...loop.run, place: { x: point.x, y: 0, z: point.z } };
        await persist(installedAppId, loop);
        lines.push(
            commands.say(
                messages.tag(loop.language) + messages.raceTarget(point.x, point.z, loop.language)
            )
        );
        return null;
    }
    const there = commands.readWhere(
        await server.say([commands.arrived(loop.run.place.x, loop.run.place.z)])
    );
    if (there.length === 0) return null;
    const winner = there[0]!.name;
    loop.run = { ...loop.run, decidedBy: winner };
    lines.push(commands.say(messages.tag(loop.language) + messages.raceWon(winner, loop.language)));
    return `${winner} reached the finish first`;
}

/**
 * A treasure hunt's tick: the chests hidden first, as many tries a tick as its
 * time allows; then one line saying how many there are, a column of light over
 * every one nobody has opened, every chest checked for being opened, and each
 * player's action bar pointing at the nearest.
 */
async function treasureHunt(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    lines: string[]
): Promise<string | null> {
    const options = loop.run.preset.options as catalog.EventOptions<"treasure-hunt">;
    const language = loop.language;
    // The rest hidden while the first are hunted: its clock starts with the first.
    if (!loop.run.hidden) await hideTreasure(installedAppId, loop, server, options);
    lines.push(...hunt.holdChests(loop.run.held));
    if (loop.run.chests.length === 0) {
        lines.push(`title @a actionbar ${commands.text(messages.huntHiding(language))}`);
        return null;
    }
    // Said once, when every chest is down: nothing more until one is opened.
    if (loop.run.hidden && loop.run.reveals < 1) {
        lines.push(
            commands.say(
                messages.tag(language) + messages.huntStart(loop.run.chests.length, language)
            ),
            commands.sound(commands.SOUNDS.tick)
        );
        loop.run = { ...loop.run, reveals: 1 };
        await persist(installedAppId, loop);
    }

    // Opened since the last look: the chest keeps its loot table until then.
    let changed = false;
    const chests = [...loop.run.chests];
    const points = { ...loop.run.points };
    for (const [index, chest] of chests.entries()) {
        if (chest.opened) continue;
        const answer = await chestTest(server, chest);
        if (answer !== "failed") continue;
        const by =
            commands.readWhere(await server.say([commands.nearest(chest, hunt.OPENER_REACH)]))[0]
                ?.name ?? null;
        chests[index] = { ...chest, opened: true, by };
        changed = true;
        const remaining = chests.filter((one) => !one.opened).length;
        lines.push(
            commands.say(
                messages.tag(language) + messages.huntOpened(by ?? "?", remaining, language)
            ),
            commands.sound(commands.SOUNDS.win)
        );
        if (by) {
            points[by] = (points[by] ?? 0) + 1;
            lines.push(commands.setScore(by, points[by] ?? 1));
        }
    }
    if (changed) {
        loop.run = { ...loop.run, chests, points };
        await persist(installedAppId, loop);
    }
    const unopened = chests.filter((one) => !one.opened);
    if (unopened.length === 0 && loop.run.hidden) {
        return `All ${chests.length} ${chests.length === 1 ? "treasure" : "treasures"} found`;
    }
    lines.push(...hunt.marks(chests));
    const players = commands.readWhere(await server.say([commands.IN_OVERWORLD]));
    lines.push(...hunt.guides(players, chests, language));
    return null;
}

/** How long one tick may spend hiding chests before it lets the rest of the
 *  event have its turn. */
const HIDE_BUDGET_MS = 6_000;

/**
 * Hide the chests, one place at a time, each through `findPlace` - so on dry,
 * open, natural ground away from every bed - each sought its own way round the
 * players (`hunt.chestBearing`), apart from the others, and only into air or a
 * small wild plant. A place that will not take one is given up for another;
 * when no more can be found, the hunt goes on with the ones that are down, and
 * fails only if none are.
 */
async function hideTreasure(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    options: catalog.EventOptions<"treasure-hunt">
): Promise<void> {
    if (!loop.run.origin) {
        const origin = hunt.centerOf(commands.readWhere(await server.say([commands.IN_OVERWORLD])));
        if (!origin) throw new PlaceNotFound();
        loop.run = { ...loop.run, origin };
    }
    await settlePendingChest(installedAppId, loop, server, options);
    // No more places to be had: the hunt goes on with the chests already down.
    const enough = async () => {
        if (loop.run.chests.length === 0) throw new PlaceNotFound();
        await server.sayAll([
            commands.CLEAR_MARK,
            ...commands.release(loop.run.place, loop.run.target),
            ...hunt.holdChests(loop.run.held)
        ]);
        loop.run = { ...loop.run, place: null, target: null, placeTries: 0, hidden: true };
        await persist(installedAppId, loop);
    };
    const until = Date.now() + HIDE_BUDGET_MS;
    for (let step = 0; step < 12 && !loop.run.hidden && Date.now() < until; step += 1) {
        const index = loop.run.chests.length;
        const found = await findPlace(
            installedAppId,
            loop,
            server,
            // Round where the most players are together, not round one of them.
            loop.run.origin ? { mode: "fixed", ...loop.run.origin } : { mode: "players" },
            hunt.huntDistance(options, Math.random),
            SPOT_RADIUS,
            commands.HOME_CLEARANCE,
            false,
            {
                nearHome: true,
                bearing: hunt.chestBearing(loop.run.id, index, options.chests),
                ...(loop.run.origin ? { walkFrom: loop.run.origin } : {})
            }
        );
        if (found === "failed") return enough();
        if (!found) continue;
        const target = loop.run.target;
        let placed = false;
        // Air or a small wild plant first, so a chest that was already there is
        // never counted as one of the hunt's - and never taken away at the end.
        const gap = loop.run.placeTries >= NEAR_AFTER ? hunt.CHEST_GAP_NEAR : hunt.CHEST_GAP;
        const apart = !hunt.tooClose(found, loop.run.chests, gap);
        let open = false;
        let was: hunt.Plant | null = null;
        if (apart) {
            open = commands.readTest(await server.say([hunt.airAt(found)])) === "passed";
            for (const plant of open ? [] : hunt.PLANTS) {
                if (
                    commands.readTest(await server.say([hunt.plantAt(found, plant)])) === "passed"
                ) {
                    was = plant;
                    open = true;
                    break;
                }
            }
        }
        const before = { chests: loop.run.chests, held: loop.run.held };
        const chest = { ...found, opened: false, by: null, was };
        if (open) {
            // Written down before it is placed, so whatever ends the event
            // takes it away again.
            loop.run = {
                ...loop.run,
                chests: [...before.chests, chest],
                held: [...before.held, ...(target ? [target] : []), { x: found.x, z: found.z }]
            };
            await persist(installedAppId, loop);
            await server.sayAll([hunt.hideChest(found, options.loot, was), commands.CLEAR_MARK]);
            // Down, and unopened: a protected area that refused the block reads
            // as nothing there.
            placed = (await chestTest(server, found)) === "passed";
        }
        if (!placed) {
            // Given up without taking the chunks of the chests already down.
            await server.sayAll([
                ...(open ? hunt.removeLines(chest) : []),
                commands.CLEAR_MARK,
                ...commands.release(found, target),
                ...hunt.holdChests(before.held)
            ]);
            loop.run = {
                ...loop.run,
                ...before,
                place: null,
                target: null,
                placeTries: loop.run.placeTries + 1
            };
            await persist(installedAppId, loop);
            if (loop.run.placeTries >= placeLimit(loop, true)) return enough();
            continue;
        }
        loop.run = {
            ...loop.run,
            place: null,
            target: null,
            placeTries: loop.placeFloor,
            hidden: loop.run.chests.length >= options.chests
        };
        await persist(installedAppId, loop);
    }
}

/**
 * A chest written down but not yet confirmed placed when Polaris stopped: kept
 * if it is there, unopened; otherwise taken off the list, so it is never
 * counted as found.
 */
async function settlePendingChest(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    options: catalog.EventOptions<"treasure-hunt">
): Promise<void> {
    const place = loop.run.place;
    const last = loop.run.chests.at(-1);
    if (!place || !last || last.opened) return;
    if (last.x !== place.x || last.y !== place.y || last.z !== place.z) return;
    const there = (await chestTest(server, last)) === "passed";
    if (!there) {
        await server.sayAll(hunt.removeLines(last));
        loop.run = { ...loop.run, chests: loop.run.chests.slice(0, -1) };
    }
    loop.run = {
        ...loop.run,
        place: null,
        target: null,
        hidden: loop.run.chests.length >= options.chests
    };
    await persist(installedAppId, loop);
}

/**
 * A gathering's round `round` (from 0) begun: its material drawn - one no round
 * before had, while any is left - written down with when it ends, its counts
 * made afresh, and said: a title, and one line with what one is worth.
 */
async function gatheringRound(
    installedAppId: string,
    loop: Loop,
    now: number,
    round: number
): Promise<string[]> {
    const options = loop.run.preset.options as catalog.EventOptions<"gathering">;
    const language = loop.language;
    const material = gather.drawMaterial(options, Math.random, loop.run.materials);
    loop.run = {
        ...loop.run,
        material,
        materials: [...loop.run.materials, material],
        round,
        roundEndsAt: now + options.roundMinutes * 60_000
    };
    await persist(installedAppId, loop);
    return [
        ...gather.gatheringSetup(material, round === 0),
        ...gather.gatheringTick(material),
        ...commands.titleCommands(
            messages.gatherRoundTitle(round + 1, options.rounds, language),
            messages.gatherTarget(material, language)
        ),
        commands.say(
            messages.tag(language) +
                messages.gatherRoundLine(
                    round + 1,
                    options.rounds,
                    material,
                    gather.WORTH[material],
                    language
                )
        ),
        commands.sound(commands.SOUNDS.start)
    ];
}

/** A gathering's tick: everybody's count brought up to date, and shown to them;
 *  a round that is over added to the points, and the next one begun. */
async function gathering(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    now: number,
    lines: string[]
): Promise<void> {
    const options = loop.run.preset.options as catalog.EventOptions<"gathering">;
    let material = gather.materialOf(loop.run.material, options);
    const next = loop.run.round + 1;
    if (loop.run.roundEndsAt !== null && now >= loop.run.roundEndsAt && next < options.rounds) {
        // Its last count, kept, before the next round empties the counts.
        await server.sayAll([...gather.gatheringTick(material), ...gather.BANK_ROUND]);
        await server.sayAll(await gatheringRound(installedAppId, loop, now, next));
        material = gather.materialOf(loop.run.material, options);
    }
    await server.sayAll(gather.gatheringTick(material));
    const counts = commands.readScores(await server.say([gather.READ_PROGRESS]));
    for (const [name, count] of counts) {
        lines.push(
            commands.actionbarFor(
                name,
                messages.gatherBar(material, Math.max(0, count), loop.language)
            )
        );
    }
}

/** A rare catch's tick: whoever landed the treasure off a line since the last look wins. */
async function rareCatchTick(
    loop: Loop,
    server: ServerContainer,
    lines: string[]
): Promise<string | null> {
    const options = loop.run.preset.options as catalog.EventOptions<"rare-catch">;
    await server.sayAll(rareCatch.catchLook(options));
    const caught = commands.readWhere(await server.say([rareCatch.READ_CATCHERS]));
    await server.sayAll(rareCatch.catchCommit());
    const winner = caught[0]?.name ?? null;
    if (!winner) {
        lines.push(
            `title @a actionbar ${commands.text(messages.catchBar(options.treasure, loop.language))}`
        );
        return null;
    }
    loop.run = { ...loop.run, decidedBy: winner };
    lines.push(
        commands.say(messages.tag(loop.language) + messages.catchWon(winner, loop.language)),
        ...commands.titleCommands(
            messages.winnerTitle(winner, loop.language),
            `&e${messages.catchName(options.treasure, loop.language)}`
        )
    );
    return `Caught by ${winner}`;
}

/** The round being played in one language: what it asks and what counts as right. */
function roundIn(
    run: stored.EventRun,
    language: catalog.Language
): { kind: "question" | "scramble"; asked: string; accepted: string[] } {
    const options = run.preset.options as catalog.EventOptions<"trivia">;
    const random = trivia.seeded(run.id);
    const questions = [
        ...options.questions,
        ...trivia.shuffled(trivia.QUESTIONS[language], random)
    ];
    const words = trivia.shuffled(trivia.WORDS[language], random);
    const scrambleRound =
        options.mode === "scramble" || (options.mode === "mixed" && run.round % 2 === 1);
    if (scrambleRound) {
        const word = words[run.round % words.length] as string;
        return {
            kind: "scramble",
            asked: trivia.scramble(word, trivia.seeded(`${run.id}-${run.round}`)),
            accepted: [word]
        };
    }
    const question = questions[run.round % questions.length]!;
    return { kind: "question", asked: question.question, accepted: [...question.answers] };
}

/**
 * The round being played: each language's readers are asked their own question
 * (the operator's own are the same for everybody), and the first right answer
 * to any of them takes it. `answer` is the right one, as each reader reads it.
 */
function roundOf(
    run: stored.EventRun,
    language: speech.Speech
): { kind: "question" | "scramble"; asked: string; answer: string; accepted: string[] } {
    const each = Object.fromEntries(
        speech.LANGUAGES.map((one) => [one, roundIn(run, one)])
    ) as Record<catalog.Language, ReturnType<typeof roundIn>>;
    const first = each[speech.LANGUAGES[0]];
    const pick = (value: (one: ReturnType<typeof roundIn>) => string) =>
        speech.pickIn(
            Object.fromEntries(speech.LANGUAGES.map((one) => [one, value(each[one])])) as Record<
                catalog.Language,
                string
            >,
            language
        );
    return {
        kind: first.kind,
        asked: pick((one) => one.asked),
        answer: pick((one) => one.accepted[0] ?? ""),
        accepted: [...new Set(speech.LANGUAGES.flatMap((one) => each[one].accepted))]
    };
}

async function triviaTick(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    now: number,
    lines: string[]
): Promise<string | null> {
    const options = loop.run.preset.options as catalog.EventOptions<"trivia">;
    const language = loop.language;
    const open = loop.run.roundEndsAt !== null;

    if (!open) {
        if (loop.run.round >= 0 && now - loop.run.closedAt < catalog.ROUND_PAUSE_SECONDS * 1000)
            return null;
        const round = loop.run.round + 1;
        if (round >= options.rounds) return "All rounds played";
        loop.run = { ...loop.run, round, roundEndsAt: now + options.seconds * 1000 };
        loop.logFrom = await containerFileSize(server, LOG_FILE);
        const asked = roundOf(loop.run, language);
        const scramble = asked.kind === "scramble";
        // On screen as well as in the chat, where a line scrolls away under the
        // answers: a title as it is asked, then the action bar until it closes.
        lines.push(
            ...commands.titleCommands(
                messages.roundTitle(round + 1, options.rounds, language),
                messages.roundSubtitle(asked.asked, scramble, language)
            ),
            `title @a actionbar ${commands.text(messages.roundBar(asked.asked, scramble, options.seconds, language))}`,
            commands.say(
                messages.tag(language) +
                    (scramble
                        ? messages.scrambleLine(round + 1, options.rounds, asked.asked, language)
                        : messages.questionLine(round + 1, options.rounds, asked.asked, language))
            ),
            commands.sound(commands.SOUNDS.tick)
        );
        await persist(installedAppId, loop);
        return null;
    }

    const asked = roundOf(loop.run, language);
    const size = await containerFileSize(server, LOG_FILE);
    // A restart lost where the log was when the round was asked: from now is
    // the fair answer, since nobody can have answered while nobody was looking.
    if (loop.logFrom === null) {
        loop.logFrom = size;
        return null;
    }
    const said =
        size === null
            ? null
            : await readContainerRange(
                  server,
                  LOG_FILE,
                  size < loop.logFrom ? 0 : loop.logFrom,
                  size
              ).catch(() => null);
    if (size !== null) loop.logFrom = size;
    const winner = said ? firstRight(said, asked.accepted) : null;
    if (winner) {
        const points = { ...loop.run.points, [winner]: (loop.run.points[winner] ?? 0) + 1 };
        loop.run = { ...loop.run, points, roundEndsAt: null, closedAt: now };
        lines.push(
            commands.setScore(winner, points[winner] ?? 1),
            ...commands.titleCommands(
                messages.roundWonTitle(winner, language),
                `&f${asked.answer}`
            ),
            commands.say(
                messages.tag(language) + messages.roundWon(winner, asked.answer, language)
            ),
            commands.sound(commands.SOUNDS.win)
        );
        await persist(installedAppId, loop);
        return null;
    }
    if (now >= (loop.run.roundEndsAt ?? now)) {
        loop.run = { ...loop.run, roundEndsAt: null, closedAt: now };
        lines.push(
            ...commands.titleCommands(messages.roundMissedTitle(language), `&f${asked.answer}`),
            commands.say(messages.tag(language) + messages.roundMissed(asked.answer, language))
        );
        await persist(installedAppId, loop);
        return null;
    }
    // Still open: the question stays above the hotbar, the time counting down.
    lines.push(
        `title @a actionbar ${commands.text(
            messages.roundBar(
                asked.asked,
                asked.kind === "scramble",
                ((loop.run.roundEndsAt ?? now) - now) / 1000,
                language
            )
        )}`
    );
    return null;
}

/** Every chat line in a stretch of log, oldest first: who said it, and what. */
export function chatLines(log: string): { name: string; text: string }[] {
    return [...log.matchAll(commands.CHAT_LINE)].map((match) => ({
        name: match[1] as string,
        text: (match[2] as string).trim()
    }));
}

/** Whoever said a right answer first in a stretch of log. */
export function firstRight(log: string, accepted: readonly string[]): string | null {
    for (const match of log.matchAll(commands.CHAT_LINE)) {
        if (trivia.answers(match[2] as string, accepted)) return match[1] as string;
    }
    return null;
}

// ------------------------------------------------------------------ horde defense

/**
 * A horde defense: the point found and marked, then wave after wave summoned
 * round it once somebody is there to meet it. A wave ends when none of its
 * monsters is left, or when its time is up (what is left of it is taken away);
 * whoever is at the point then has held it. Decided when the last wave ends.
 */
async function hordeDefense(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    now: number,
    lines: string[]
): Promise<string | null> {
    const options = loop.run.preset.options as catalog.EventOptions<"waves">;
    const language = loop.language;
    const timing = catalog.WAVE_TIMING;
    // Players die in this one. Without keepInventory held on, a death would
    // cost what they carry, so it does not go ahead at all.
    if (!waves.KEEP_INVENTORY.some((rule) => loop.run.gamerules[rule] !== undefined)) {
        throw new CannotRun("The server would not say whether it keeps inventories on death");
    }
    if (!loop.run.place) {
        const found = await findPlace(
            installedAppId,
            loop,
            server,
            options.place,
            48,
            waves.DEFENSE_RADIUS,
            waves.CLEARANCE
        );
        if (found === "failed") throw new PlaceNotFound();
        if (!found) return null;
        // The ground round it held loaded, so no monster is ever out of reach
        // of the end - only the chunks nobody held already, and written down
        // before they are, so the end lets go of exactly those.
        const held = chunks.readForced(await server.say([chunks.READ_FORCED]));
        const hold = chunks.notHeld(chunks.chunksAround(found.x, found.z, waves.LOAD_REACH), held);
        loop.run = { ...loop.run, chunks: hold, round: -1, roundEndsAt: null, closedAt: now };
        await persist(installedAppId, loop);
        await server.sayAll([
            ...hold.map(chunks.holdChunk),
            commands.CLEAR_MARK,
            ...commands.titleCommands(
                messages.wavesPointTitle(language),
                `&fX ${found.x} Y ${found.y} Z ${found.z}`
            ),
            commands.say(
                messages.tag(language) + messages.wavesPointAt(found.x, found.y, found.z, language)
            ),
            commands.sound(commands.SOUNDS.horn)
        ]);
        return null;
    }
    const place = loop.run.place;
    const open = loop.run.roundEndsAt !== null;
    lines.push(
        ...waves.wavesMarks(place),
        waves.leash(place),
        ...waves.wavesTick(place, options.mix, open, options.winner === "damage")
    );
    /** Monsters of the wave on now still about, as far as is known. */
    let left: number | null = null;
    if (open) {
        const wave = loop.run.round;
        const alive = waves.readAlive(await server.say([waves.WAVE_ALIVE]));
        const timedOut = now >= (loop.run.roundEndsAt ?? now);
        left = alive;
        if (alive === 0 || timedOut) {
            const at = commands
                .readWhere(await server.say([waves.defenders(place)]))
                .map((one) => one.name);
            const survived = { ...loop.run.survived };
            for (const name of at) survived[name] = (survived[name] ?? 0) + 1;
            loop.run = { ...loop.run, survived, roundEndsAt: null, closedAt: now };
            await persist(installedAppId, loop);
            const cleared = alive === 0;
            lines.push(
                // What is left of a wave out of time goes, so the next one
                // starts clean.
                ...(cleared ? [waves.MOUNTS_GONE] : [`kill @e[tag=${commands.MOB_TAG}]`]),
                ...commands.titleCommands(
                    cleared
                        ? messages.waveCleared(wave + 1, language)
                        : messages.waveOver(wave + 1, language),
                    messages.waveHeldBy(at.length, language)
                ),
                commands.sound(cleared ? commands.SOUNDS.win : commands.SOUNDS.tick)
            );
            if (wave + 1 >= options.waves) return `All ${options.waves} waves were fought`;
        }
    } else if (
        now - loop.run.closedAt >=
        (loop.run.round < 0 ? timing.firstSeconds : timing.pauseSeconds) * 1000
    ) {
        // Due: it comes as soon as somebody is at the point to meet it.
        const at = commands.readWhere(await server.say([waves.defenders(place)]));
        if (at.length > 0) {
            const wave = loop.run.round + 1;
            const count = waves.waveSize(options.size, wave, at.length);
            loop.run = { ...loop.run, round: wave, roundEndsAt: now + timing.limitSeconds * 1000 };
            // Written down before anything is summoned: a restart then knows
            // a wave is out, and the end takes it away.
            await persist(installedAppId, loop);
            left = count;
            lines.push(
                ...waves.summonWave(
                    place,
                    options.mix,
                    count,
                    wave,
                    (loop.run.endsAt - now) / 1000 + 60,
                    { waves: options.waves, defenders: at.length }
                ),
                ...commands.titleCommands(
                    messages.waveTitle(wave + 1, options.waves, language),
                    messages.waveSubtitle(count, language)
                ),
                commands.sound(commands.SOUNDS.horn)
            );
        }
    }

    // Where the defense stands, on the bar and at the point; the way to it
    // for everybody further off.
    const run = loop.run;
    const fighting = run.roundEndsAt !== null;
    const number = (fighting ? run.round : run.round + 1) + 1;
    const wait = (run.round < 0 ? timing.firstSeconds : timing.pauseSeconds) * 1000;
    let status: string;
    let bar: { value: number; max: number };
    if (fighting) {
        const seconds = ((run.roundEndsAt ?? now) - now) / 1000;
        status = `${messages.waveFighting(number, options.waves, left ?? 0, language)} &7${messages.clock(seconds)}`;
        bar = { value: seconds, max: timing.limitSeconds };
    } else if (now - run.closedAt >= wait) {
        status = messages.waveWaiting(number, options.waves, language);
        bar = { value: 1, max: 1 };
    } else {
        const seconds = (wait - (now - run.closedAt)) / 1000;
        status = messages.waveComing(number, options.waves, seconds, language);
        bar = { value: seconds, max: wait / 1000 };
    }
    lines.push(...commands.barUpdate(status, bar.value, bar.max));
    for (const one of commands.readWhere(await server.say([commands.IN_OVERWORLD]))) {
        const center = { x: place.x + 0.5, z: place.z + 0.5 };
        const away = Math.hypot(one.x - center.x, one.z - center.z);
        lines.push(
            commands.actionbarFor(
                one.name,
                away <= waves.AREA
                    ? status
                    : messages.wavesGuide(
                          Math.round(away),
                          commands.headingTo(one, center),
                          language
                      )
            )
        );
    }
    return null;
}

// ------------------------------------------------------------------ meteor shower

/**
 * A meteor shower: the meteors brought down one after another, a few seconds
 * apart (`meteors.meteorGap`), each where `findPlace` finds open ground - on
 * an island, the island - then raced to. A meteor with a player near it that
 * is no longer whole is looked at block by block, and any block no longer its
 * ore is forgotten for good. Decided once every meteor is down and mined out.
 */
async function meteorShower(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    now: number,
    lines: string[]
): Promise<string | null> {
    const options = loop.run.preset.options as catalog.EventOptions<"meteor-shower">;
    const language = loop.language;
    const due = meteors.dueMeteors(
        now - loop.run.startsAt,
        loop.run.endsAt - loop.run.startsAt,
        options.meteors
    );
    // Both steps of finding a place in the one tick: the column chosen, then the
    // ground there judged.
    for (let step = 0; step < 2 && loop.run.landings < due; step += 1) {
        const found = await findPlace(
            installedAppId,
            loop,
            server,
            options.place,
            options.distance,
            meteors.RADIUS,
            commands.HOME_CLEARANCE,
            false,
            // Ore put only into air, and taken out again: on an island it comes
            // down on the island, where it can be walked to.
            { nearHome: true, walkFrom: await walkStart(server, options.place) }
        );
        if (found === "failed") {
            // Nowhere for this one: it is let go, and the next looked for afresh.
            loop.run = { ...loop.run, landings: loop.run.landings + 1, placeTries: 0 };
            await persist(installedAppId, loop);
            break;
        }
        if (found) {
            await landMeteor(installedAppId, loop, server, found, options);
            break;
        }
    }

    // Whatever of a meteor somebody near it has mined is forgotten: it is no
    // longer the event's to take away, whatever is put there after.
    const players = commands.readWhere(await server.say([commands.IN_OVERWORLD]));
    let emptied = 0;
    const checked: stored.EventRun["meteors"] = [];
    for (const meteor of loop.run.meteors) {
        const near =
            meteor.blocks.length > 0 &&
            players.some(
                (one) =>
                    Math.hypot(
                        one.x - (meteor.x + 0.5),
                        one.y - meteor.y,
                        one.z - (meteor.z + 0.5)
                    ) <= meteors.NEAR
            );
        const whole = meteors.allOurs(meteor);
        if (!near || (whole && commands.readTest(await server.say([whole])) === "passed")) {
            checked.push(meteor);
            continue;
        }
        const kept: typeof meteor.blocks = [];
        for (const block of meteor.blocks) {
            if (commands.readTest(await server.say([meteors.isOurs(block)])) !== "failed")
                kept.push(block);
        }
        if (kept.length === 0) emptied += 1;
        checked.push({ ...meteor, blocks: kept });
    }
    if (
        checked.some((meteor, at) => meteor.blocks.length !== loop.run.meteors[at]?.blocks.length)
    ) {
        loop.run = { ...loop.run, meteors: checked };
        await persist(installedAppId, loop);
    }
    if (emptied > 0)
        lines.push(commands.say(messages.tag(language) + messages.meteorMinedOut(language)));

    const live = loop.run.meteors.filter((meteor) => meteor.blocks.length > 0);
    lines.push(...meteors.meteorTick(loop.run.meteors, options.ores), ...live.map(commands.beam));
    // Each player pointed at the nearest meteor still to mine.
    for (const one of players) {
        const away = (meteor: (typeof live)[number]) =>
            Math.hypot(one.x - (meteor.x + 0.5), one.z - (meteor.z + 0.5));
        const nearest = [...live].sort((a, b) => away(a) - away(b))[0];
        if (!nearest) {
            lines.push(commands.actionbarFor(one.name, messages.meteorWaiting(language)));
            continue;
        }
        const center = { x: nearest.x + 0.5, z: nearest.z + 0.5 };
        lines.push(
            commands.actionbarFor(
                one.name,
                messages.meteorGuide(
                    Math.round(away(nearest)),
                    commands.headingTo(one, center),
                    nearest.blocks.length,
                    language
                )
            )
        );
    }

    if (loop.run.landings < options.meteors || live.length > 0) return null;
    // Every one down and mined out - unless none could come down at all.
    if (loop.run.meteors.length === 0) throw new PlaceNotFound();
    return "Every meteor was mined out";
}

/**
 * One meteor down on a place just found: the cells that are air now written
 * down first, then filled with ore - `keep`, so only air is ever filled - and
 * then only the cells that really hold that ore kept as the meteor's.
 */
async function landMeteor(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    found: stored.Point,
    options: catalog.EventOptions<"meteor-shower">
): Promise<void> {
    const language = loop.language;
    const cells = meteors.meteorCells(found, options.size, options.ores, Math.random);
    const free: meteors.MeteorBlock[] = [];
    for (const cell of cells) {
        if (commands.readTest(await server.say([meteors.airTest(cell)])) === "passed")
            free.push(cell);
    }
    // The chunks it lies across held until the end, so it can still be taken
    // away: the place's own and the column's, which finding it loaded, and the
    // ones round it nobody held already.
    const held = chunks.readForced(await server.say([chunks.READ_FORCED]));
    const known = new Set(loop.run.chunks.map((chunk) => `${chunk.x},${chunk.z}`));
    const added = [
        ...chunks.notHeld(chunks.chunksAround(found.x, found.z, 1), held),
        { x: found.x >> 4, z: found.z >> 4 },
        ...(loop.run.target ? [{ x: loop.run.target.x >> 4, z: loop.run.target.z >> 4 }] : [])
    ].filter((chunk) => {
        const key = `${chunk.x},${chunk.z}`;
        if (known.has(key)) return false;
        known.add(key);
        return true;
    });
    const index = loop.run.meteors.length;
    loop.run = {
        ...loop.run,
        meteors: [...loop.run.meteors, { x: found.x, y: found.y, z: found.z, blocks: free }],
        chunks: [...loop.run.chunks, ...added],
        // The place and the column tried are the meteor's now, let go with
        // its chunks; the next one is looked for afresh.
        place: null,
        target: null,
        placeTries: 0,
        landings: loop.run.landings + 1
    };
    // Written down before a block is placed, so an end at any moment after
    // knows what to take away.
    await persist(installedAppId, loop);
    await server.sayAll([
        ...added.map(chunks.holdChunk),
        ...free.map(meteors.placeBlock),
        commands.CLEAR_MARK
    ]);
    const ours: meteors.MeteorBlock[] = [];
    for (const block of free) {
        if (commands.readTest(await server.say([meteors.isOurs(block)])) === "passed")
            ours.push(block);
    }
    // A meteor none of whose blocks took is no meteor: forgotten, its chunks
    // still let go at the end.
    loop.run = {
        ...loop.run,
        meteors:
            ours.length > 0
                ? loop.run.meteors.map((meteor, at) =>
                      at === index ? { ...meteor, blocks: ours } : meteor
                  )
                : loop.run.meteors.filter((_, at) => at !== index)
    };
    await persist(installedAppId, loop);
    if (ours.length === 0) return;
    await server.sayAll([
        ...meteors.landingEffects(found),
        ...commands.titleCommands(
            messages.meteorTitle(language),
            `&fX ${found.x} Y ${found.y} Z ${found.z}`
        ),
        commands.say(
            messages.tag(language) +
                messages.meteorAt(found.x, found.y, found.z, ours.length, language)
        )
    ]);
}

/**
 * What a parkour race or a spleef needs from the loop: saving, the same place
 * rules as every other event (wider, for something this big), the chat, and
 * how this server's version spells things.
 */
function stageTools(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer
): stageService.StageTools {
    return {
        persist: () => persist(installedAppId, loop),
        findSite: async (place, radius) => {
            const found = await findPlace(
                installedAppId,
                loop,
                server,
                place,
                commands.HOME_CLEARANCE + radius,
                radius,
                commands.HOME_CLEARANCE + radius,
                true,
                // Built in the air: over anything, a build or the sea; and in
                // closer after a few tries, since it changes nothing below.
                { surface: "air", nearHome: true }
            );
            if (found === "failed") throw new PlaceNotFound(NO_AIR);
            return found;
        },
        giveUpSite: (point, why) => retryPlace(installedAppId, loop, server, point, true, why),
        chat: () => newChat(server, loop),
        owed: async () => {
            const row = await readRow(installedAppId);
            return row ? owedNames(stored.readEventState(row.config)) : new Set<string>();
        },
        flavour: async () => loop.flavour ?? (loop.flavour = await stageFlavour(server)),
        itemsWork: (items) => {
            if (loop.flavour) loop.flavour = { ...loop.flavour, items };
        },
        canStash: () => serverAtLeast(server, [1, 17]),
        stashOwner: { installedAppId, runId: loop.run.id, event: loop.run.preset.name }
    };
}

/** What was written in the server log since the last look; null the first time,
 *  which only notes where the log is now. */
async function newChat(server: ServerContainer, loop: Loop): Promise<string | null> {
    const said = await newLog(server, loop);
    if (!catalog.takesJoiners(loop.run.preset)) return said;
    // A [Join] or [Leave] pressed in the chat reads as having typed it.
    const pressed = [
        ...commands.readScores(await server.say([commands.READ_JOIN_TRIGGER])).entries()
    ]
        .map(([name, value]) => commands.pressedLine(name, value))
        .filter((line): line is string => line !== null);
    await server.sayAll([commands.RESET_JOIN_TRIGGER, ...commands.joinTriggerLines()]);
    if (pressed.length === 0) return said;
    return `${said ?? ""}${said && !said.endsWith("\n") ? "\n" : ""}${pressed.join("\n")}\n`;
}

async function newLog(server: ServerContainer, loop: Loop): Promise<string | null> {
    const size = await containerFileSize(server, LOG_FILE);
    if (size === null) return null;
    if (loop.logFrom === null) {
        loop.logFrom = size;
        return null;
    }
    const from = size < loop.logFrom ? 0 : loop.logFrom;
    loop.logFrom = size;
    return size > from ? readContainerRange(server, LOG_FILE, from, size).catch(() => null) : null;
}

async function stageFlavour(server: ServerContainer): Promise<stage.Flavour> {
    return {
        items: (await serverAtLeast(server, [1, 20, 5])) ? "components" : "nbt",
        top: (await serverAtLeast(server, [1, 18])) ? 319 : 255
    };
}

/**
 * Whether an event chest is still unopened: `Test passed` while it holds its
 * loot table. A server that cannot read the question at all - 1.13, before
 * `execute if data` - is asked by the tables themselves instead.
 */
async function chestTest(
    server: ServerContainer,
    point: { x: number; y: number; z: number }
): Promise<ReturnType<typeof commands.readTest>> {
    const answer = commands.readTest(await server.say([commands.chestUnopened(point)]));
    if (answer !== "unknown") return answer;
    let seen: ReturnType<typeof commands.readTest> = "unknown";
    for (const line of commands.chestUnopenedByTable(point)) {
        const one = commands.readTest(await server.say([line]));
        if (one === "passed" || one === "unloaded") return one;
        if (one === "failed") seen = "failed";
    }
    return seen;
}

class PlaceNotFound extends Error {
    constructor(why: string = NO_GROUND) {
        super(why);
    }
}

/** Something the event needs that this server will not give it: it fails, and
 *  says why, the same way as when there is nowhere to hold it. */
class CannotRun extends PlaceNotFound {
    constructor(reason: string) {
        super();
        this.message = reason;
    }
}

// ------------------------------------------------------------------ the end

/**
 * The event over: scores read, the podium worked out, prizes handed to whoever
 * is on and kept for whoever is not, everything it put in the world taken out
 * again, and a line in the history saying how it went.
 */
async function finish(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer | null,
    outcome: stored.EventOutcome,
    note: string
): Promise<void> {
    // Off the timer first, so no tick runs into the end; the connection is
    // kept until everything below has been said through it. The loop stays
    // known, and the run marked, until the end is written down, so nothing
    // picks the same run up again and hands its prizes out twice.
    if (loop.finishing) return;
    loop.finishing = true;
    clearInterval(loop.timer);
    if (loop.clock) clearInterval(loop.clock);
    if (loop.quick) clearInterval(loop.quick);
    const run = loop.run;
    await updateEventState(installedAppId, (state) =>
        state.run?.id === run.id ? { ...state, run: { ...state.run, finishing: true } } : state
    ).catch((error: unknown) =>
        console.warn("polaris: marking an event finished failed", installedAppId, String(error))
    );
    const { preset } = run;
    const language = loop.language;
    const info = catalog.KIND_INFO[preset.kind];
    let placed: plan.Placed[] = [];
    let disqualified = new Set<string>();
    const pending: stored.PendingReward[] = [];
    const delivered: stored.DeliveredPrize[] = [];
    const lines: string[] = [];
    /** A parkour's or spleef's blocks and players, until they are all put back. */
    let stageLeftover = stage.leftoverOf(run.id, run.stage, run.keepForced);
    /** What of a team duel's or build battle's arena and its players is still
     *  to undo once this is over. */
    let arenaLeftover: stored.ArenaLeftover | null | undefined;
    /** What it came to for the challenges (`challenges/challenges-service.ts`). */
    let forChallenges: {
        ranked: string[];
        podium: string[];
        rounds: Record<string, number>;
    } | null = null;
    /**
     * Everybody back where they were - the kit taken back, their own things
     * given back (`kinds/stash`) - and every block of the stage or the arena
     * out. Before any prize, so a prize never lands in a slot that is about to
     * be given back; whatever cannot be done now is kept, and the sweep
     * finishes it. Once.
     */
    let broughtBack = false;
    const bringBack = async (to: ServerContainer): Promise<void> => {
        if (broughtBack) return;
        broughtBack = true;
        // The boss and everything it summoned out first: its arena is about
        // to come down under them.
        if (preset.kind === "world-boss") await to.sayAll(bossService.mobsGone());
        if (stageLeftover) {
            const flavour = loop.flavour ?? (await stageFlavour(to));
            stageLeftover = await stageService.settle(to, stageLeftover, flavour, language);
        }
        if (catalog.playsInArena(preset)) {
            const open = arenaService.leftoverOf(run);
            arenaLeftover = open ? await arenaService.closeArena(to, open, language) : null;
        }
    };

    try {
        if (server && outcome === "finished" && run.phase === "running" && info.competitive) {
            disqualified = await disqualifiedSince(installedAppId, run.startsAt);
            // Also off the podium: whoever played it in creative or spectator,
            // and - where standing still all the way through is a way to win -
            // whoever was AFK from start to finish.
            for (const name of run.offMode) disqualified.add(name.toLowerCase());
            if (catalog.afkCounts(preset)) {
                for (const name of plan.idleThroughout(
                    playing.seenOn(installedAppId),
                    run.startsAt
                )) {
                    disqualified.add(name.toLowerCase());
                }
            }
            const { scores, took } = await results(server, run);
            const minimum = catalog.minScoreOf(preset);
            if (preset.kind === "world-boss" && run.decidedBy) {
                // The final blow took part, whatever it was dealt with.
                const killer = run.decidedBy;
                if (!took.some((name) => name.toLowerCase() === killer.toLowerCase()))
                    took.push(killer);
            }
            // A world boss is won by the most damage, or by the final blow when
            // the event says so (`bossService.podiumOf`).
            placed =
                preset.kind === "world-boss"
                    ? bossService.podiumOf(run, scores, disqualified, minimum)
                    : plan.podium(scores, disqualified, minimum);
            // Taking part is reaching the minimum too - one zombie is not taking part
            // in a hunt. A blood moon's is surviving it with a kill, and a horde
            // defense's holding the point, which are their own bars.
            const counted =
                preset.kind === "blood-moon" ||
                preset.kind === "waves" ||
                // A boss is fought together: any damage to it is taking part.
                preset.kind === "world-boss"
                    ? took
                    : took.filter((name) => (scores.get(name) ?? 0) >= minimum);
            const owed = plan.prizes(
                placed,
                counted,
                preset.kind === "world-boss" ? bossService.rewardsOf(run) : preset.rewards,
                disqualified
            );
            forChallenges = {
                ranked: counted.filter((name) => !disqualified.has(name.toLowerCase())),
                podium: placed.map((one) => one.name),
                rounds: preset.kind === "trivia" ? { ...run.points } : {}
            };
            // The kit off and their own things back first; only then the prizes.
            await bringBack(server);
            const online = new Set(
                commands
                    .readWhere(await server.say([commands.WHERE]))
                    .map((one) => one.name.toLowerCase())
            );
            for (const { name, reward } of owed) {
                if (!catalog.PLAYER_NAME.test(name)) continue;
                let left: catalog.Reward | null = reward;
                if (online.has(name.toLowerCase())) {
                    const handed = await give(server, name, reward);
                    left = handed.left;
                    delivered.push(handed.delivered);
                }
                if (!left)
                    lines.push(
                        `tellraw ${name} ${commands.text(messages.rewardGiven(preset.name, language))}`
                    );
                else
                    pending.push({
                        id: `${run.id}-${name}`,
                        player: name,
                        reward: left,
                        event: preset.name,
                        createdAt: Date.now()
                    });
            }
            // The boss's trophy, besides whatever the podium paid: to the most
            // damage, or to the final blow (`bossService.trophyWinner`).
            const trophyTo =
                preset.kind === "world-boss" ? bossService.trophyWinner(run, placed) : null;
            if (trophyTo && online.has(trophyTo.toLowerCase())) {
                const trophy = await bossService.awardTrophy(
                    server,
                    run,
                    loop.home,
                    (await serverAtLeast(server, [1, 21, 5]))
                        ? "text"
                        : (await serverAtLeast(server, [1, 20, 5]))
                          ? "json"
                          : "tag",
                    trophyTo
                );
                if (trophy) {
                    const winner = trophyTo.toLowerCase();
                    const at = delivered.findIndex((one) => one.name.toLowerCase() === winner);
                    const item = { id: trophy.id, count: trophy.count, dropped: trophy.dropped };
                    if (at >= 0)
                        delivered[at] = {
                            ...delivered[at]!,
                            items: [...delivered[at]!.items, item]
                        };
                    else delivered.push({ name: trophyTo, items: [item], levels: 0 });
                }
            }
            lines.push(commands.say(messages.resultsHeader(preset.name, language)));
            if (catalog.playsInArena(preset))
                lines.push(...arenaService.resultLines(run, language));
            if (preset.kind === "world-boss" && !run.decidedBy) {
                lines.push(
                    commands.say(messages.bossEscaped(bossService.nameOf(run, language), language))
                );
            } else if (preset.kind === "supply-drop" && !run.decidedBy) {
                lines.push(commands.say(messages.dropLost(language)));
            } else if (preset.kind === "rare-catch" && !run.decidedBy) {
                lines.push(commands.say(messages.catchMissed(language)));
            } else if (preset.kind === "treasure-hunt") {
                const unfound = run.chests.filter((one) => !one.opened).length;
                if (unfound > 0) lines.push(commands.say(messages.huntUnfound(unfound, language)));
            } else if (preset.kind === "waves") {
                const fought = run.roundEndsAt === null ? run.round + 1 : run.round;
                lines.push(
                    commands.say(
                        messages.wavesHeld(
                            Math.max(0, fought),
                            (preset.options as catalog.EventOptions<"waves">).waves,
                            language
                        )
                    )
                );
            }
            if (placed.length === 0) lines.push(commands.say(messages.nobodyScored(language)));
            for (const one of placed) {
                lines.push(
                    commands.say(
                        messages.podiumLine(
                            one.place,
                            one.name,
                            scoreText(preset, one.score, language),
                            language
                        )
                    )
                );
            }
            // Everybody's damage, not only the podium's: what each dealt is theirs to see.
            const ranking =
                preset.kind === "world-boss"
                    ? bossService.rankingLine(scores, disqualified, language)
                    : null;
            if (ranking) lines.push(commands.say(ranking));
            if (disqualified.size > 0) {
                const names = run.participants.filter((name) =>
                    disqualified.has(name.toLowerCase())
                );
                if (names.length > 0)
                    lines.push(commands.say(messages.disqualifiedLine(names, language)));
            }
            if (pending.length > 0) lines.push(commands.say(messages.rewardWaiting(language)));
            const winner = placed[0];
            lines.push(
                ...commands.titleCommands(
                    winner
                        ? messages.winnerTitle(winner.name, language)
                        : messages.endedTitle(language),
                    `&e${preset.name}`
                ),
                commands.sound(commands.SOUNDS.win)
            );
        } else if (server && outcome === "finished" && preset.kind === "happy-hour") {
            lines.push(commands.say(messages.tag(language) + messages.happyHourOver(language)));
        } else if (server && outcome === "finished" && preset.kind === "xp-boost") {
            lines.push(commands.say(messages.tag(language) + messages.boostOver(language)));
        } else if (server && (outcome === "cancelled" || outcome === "failed")) {
            lines.push(
                commands.say(
                    messages.tag(language) + messages.cancelledLine(preset.name, language, note)
                )
            );
        }
        if (server) {
            if (preset.kind === "blood-moon" && outcome === "finished") {
                const survivors = await survivorsOf(server, run);
                lines.unshift(
                    commands.say(messages.tag(language) + messages.dawn(survivors.length, language))
                );
            }
            // Everybody back where they were before the results are read to
            // them and before the rules they held are put back.
            await bringBack(server);
            await server.sayAll([...lines, ...cleanupOf(run)]);
        } else {
            // The server was not answering: clean up when it is back, so a
            // chest, a boss or a loaded chunk is not left in the world for good.
            if (catalog.playsInArena(preset))
                arenaLeftover = arenaService.leftoverOf(run, run.gamerules);
            await cleanUpLater(loop.ownerId, installedAppId, run);
        }
    } catch (error) {
        console.warn("polaris: finishing an event failed", installedAppId, String(error));
        if (arenaLeftover === undefined && catalog.playsInArena(preset))
            arenaLeftover = arenaService.leftoverOf(run, run.gamerules);
        if (server) await server.sayAll(cleanupOf(run)).catch(() => undefined);
    } finally {
        releaseSidebar(loop.ownerId, installedAppId);
        await dropLink(loop);
    }

    const entry: stored.EventHistoryEntry = {
        id: run.id,
        presetId: preset.id,
        kind: preset.kind,
        name: preset.name,
        trigger: run.trigger,
        outcome,
        note,
        startedAt: run.startsAt,
        endedAt: Date.now(),
        participants: run.participants.length,
        podium: placed,
        disqualified: run.participants.filter((name) => disqualified.has(name.toLowerCase())),
        delivered,
        // Nowhere would do: where it looked, and what was in the way.
        search:
            outcome === "failed" && !run.place && run.placeLog.length > 0
                ? search.summarize(run.placeFrom, run.placeLog, run.overSea)
                : null,
        keptOut: run.keptOut ?? []
    };
    await updateEventState(installedAppId, (state) => ({
        ...stored.withHistory(
            { ...state, run: state.run?.id === run.id ? null : state.run },
            entry
        ),
        lastKind: preset.kind,
        pending: stored.livePending([...state.pending, ...pending], Date.now()),
        stageLeftovers: stage.withLeftover(state.stageLeftovers, stageLeftover),
        arenaLeftovers: arenaLeftover
            ? [...state.arenaLeftovers, arenaLeftover]
            : state.arenaLeftovers
    })).catch((error: unknown) =>
        console.warn("polaris: recording an event failed", installedAppId, String(error))
    );
    if (loops.get(installedAppId) === loop) loops.delete(installedAppId);
    bossService.forget(run.id);
    // Events feed the challenges: taking part, the podium, trivia rounds won.
    if (forChallenges) {
        const result = { participants: run.participants.length, ...forChallenges };
        void import("../challenges/challenges-service")
            .then((challenges) => challenges.creditEventResults(installedAppId, result))
            .catch((error: unknown) =>
                console.warn(
                    "polaris: counting an event for challenges failed",
                    installedAppId,
                    String(error)
                )
            );
    }
}

/**
 * Everything a run put into the world, taken out, built from the stored run
 * alone so it is the same after a restart: what its own kind put there first -
 * while the chunks it lies in are still held - then what every event leaves
 * (`commands.cleanup`), then what its kind tidies after that, then the chunks
 * it held besides its place.
 */
export function cleanupOf(run: stored.EventRun): string[] {
    const before: string[] = [];
    const after: string[] = [];
    switch (run.preset.kind) {
        case "waves":
            before.push(
                ...waves.wavesCleanup((run.preset.options as catalog.EventOptions<"waves">).mix)
            );
            break;
        case "meteor-shower": {
            const ores = (run.preset.options as catalog.EventOptions<"meteor-shower">).ores;
            before.push(...meteors.meteorCleanup(run.meteors, ores));
            break;
        }
        case "xp-boost":
            // The last payout, before the shared cleanup takes its objectives away.
            before.push(
                ...boost.boostCleanup(run.preset.options as catalog.EventOptions<"xp-boost">)
            );
            break;
        case "treasure-hunt":
            after.push(...hunt.huntCleanup(run.chests, run.held));
            break;
        case "king-of-the-hill":
            // Its platform over the sea, while its chunks are held.
            before.push(...hillService.platformCleanup(run));
            break;
        case "world-boss":
            // Its minions, vexes and fangs, while their chunks are still held.
            before.push(...bossService.mobsGone());
            break;
        case "gathering":
            after.push(...gather.gatheringCleanup());
            break;
        case "parkour":
            after.push(...parkour.SCORES_REMOVED);
            break;
        case "rare-catch":
            after.push(...rareCatch.catchCleanup());
            break;
    }
    // Operators' chat is given back last, so the tidying up does not fill it either.
    const feedback: string[] = commands.FEEDBACK_RULES.filter((rule) => rule in run.gamerules);
    const rules = Object.fromEntries(
        Object.entries(run.gamerules).filter(([rule]) => !feedback.includes(rule))
    );
    return [
        ...before,
        ...commands.cleanup(run.preset, run.place, run.target, rules, run.timeBefore),
        ...after,
        ...run.chunks.map(chunks.releaseChunk),
        ...feedback
            .filter((rule) => run.gamerules[rule] === "true" || run.gamerules[rule] === "false")
            .map((rule) => commands.setRule(rule, run.gamerules[rule]!))
    ];
}

async function cleanUpLater(
    ownerId: string,
    installedAppId: string,
    run: stored.EventRun
): Promise<void> {
    await withServerContainer(ownerId, installedAppId, async (later) => {
        if (later.running)
            await chunks.sparing(later, () => chunks.heldBefore(run)).sayAll(cleanupOf(run));
    }).catch(() => undefined);
}

/** The call-off, told to everybody in their own language. */
async function sayCalledOff(
    ownerId: string,
    installedAppId: string,
    run: stored.EventRun
): Promise<void> {
    await withServerContainer(ownerId, installedAppId, async (server) => {
        if (!server.running) return;
        const row = await readRow(installedAppId);
        const home = await speechService.homeLanguage(
            ownerId,
            row ? catalog.chosenLanguage(row.config) : null
        );
        homes.set(installedAppId, home);
        await speechService.hear(installedAppId, server, home);
        const every = speech.EVERY;
        await server.sayAll([
            commands.say(
                messages.tag(every) + messages.cancelledLine(run.preset.name, every, "Called off")
            )
        ]);
    }).catch(() => undefined);
}

/**
 * A run whose end was begun and never written down - Polaris stopped while it
 * handed the prizes out, or the last save failed. Not played again, which could
 * give the same prizes twice: the world is tidied and the run put away.
 */
async function abandon(
    ownerId: string,
    installedAppId: string,
    run: stored.EventRun
): Promise<void> {
    await cleanUpLater(ownerId, installedAppId, run);
    // One called off before Polaris stopped is still called off, and said so.
    if (run.cancelled) await sayCalledOff(ownerId, installedAppId, run);
    releaseSidebar(ownerId, installedAppId);
    const now = Date.now();
    const entry: stored.EventHistoryEntry = {
        id: run.id,
        presetId: run.preset.id,
        kind: run.preset.kind,
        name: run.preset.name,
        trigger: run.trigger,
        outcome: run.cancelled ? "cancelled" : "failed",
        note: run.cancelled ? "Called off" : "Stopped while its results were handed out",
        startedAt: run.startsAt,
        endedAt: now,
        participants: run.participants.length,
        podium: [],
        disqualified: [],
        delivered: [],
        search: null
    };
    // An arena and whoever is in it are the minute sweep's to undo from here.
    const arenaLeftover = catalog.playsInArena(run.preset)
        ? arenaService.leftoverOf(run, run.gamerules)
        : null;
    await updateEventState(installedAppId, (state) =>
        state.run?.id === run.id
            ? {
                  ...stored.withHistory({ ...state, run: null }, entry),
                  lastKind: run.preset.kind,
                  // Its stage or arena, if it had one, is undone by the sweep from here.
                  stageLeftovers: stage.withLeftover(
                      state.stageLeftovers,
                      stage.leftoverOf(run.id, state.run.stage, state.run.keepForced)
                  ),
                  arenaLeftovers: arenaLeftover
                      ? [...state.arenaLeftovers, arenaLeftover]
                      : state.arenaLeftovers
              }
            : state
    );
}

/**
 * Arenas still standing for somebody to be taken back from, tried again: who
 * is on now is sent back, and an arena nobody is left in comes down.
 */
async function settleArenaLeftovers(
    ownerId: string,
    installedAppId: string,
    leftovers: readonly stored.ArenaLeftover[],
    language: catalog.Language
): Promise<void> {
    const settled = new Map<string, stored.ArenaLeftover | null>();
    await withServerContainer(ownerId, installedAppId, async (server) => {
        if (!server.running) return;
        for (const one of leftovers) {
            const spared = chunks.sparing(server, () => chunks.heldBefore(one));
            settled.set(one.id, await arenaService.closeArena(spared, one, language));
        }
    }).catch((error: unknown) =>
        console.warn("polaris: settling an event's arena failed", installedAppId, String(error))
    );
    if (settled.size === 0) return;
    await updateEventState(installedAppId, (state) => ({
        ...state,
        arenaLeftovers: state.arenaLeftovers.flatMap((one) => {
            if (!settled.has(one.id)) return [one];
            const next = settled.get(one.id);
            return next ? [next] : [];
        })
    }));
}

/** A score the way the podium says it: `12 points`, `3:20` for time on the hill. */
function scoreText(preset: catalog.EventPreset, score: number, language: speech.Speech): string {
    if (preset.kind === "supply-drop" || preset.kind === "rare-catch") return "";
    const stageText = stageService.scoreText(preset.kind, score, language);
    if (stageText !== null) return stageText;
    if (preset.kind === "king-of-the-hill") return messages.clock(score);
    const unit = catalog.unitOf(preset);
    return unit ? `${score} ${unit}` : String(score);
}

/**
 * The final scores, and everybody who took part in the event's own sense:
 * scored at all - and, on a blood moon, lived to see the dawn.
 */
async function results(
    server: ServerContainer,
    run: stored.EventRun
): Promise<{ scores: Map<string, number>; took: string[] }> {
    const { preset } = run;
    if (preset.kind === "trivia" || preset.kind === "treasure-hunt") {
        const scores = new Map(Object.entries(run.points));
        return { scores, took: [...scores.keys()] };
    }
    if (catalog.playsInArena(preset)) return arenaService.arenaResults(run);
    if (
        preset.kind === "supply-drop" ||
        preset.kind === "rare-catch" ||
        (preset.kind === "explorer" && isRace(preset))
    ) {
        const scores = new Map<string, number>(run.decidedBy ? [[run.decidedBy, 1]] : []);
        return { scores, took: [] };
    }
    if (preset.kind === "world-boss" && !run.decidedBy) return { scores: new Map(), took: [] };
    if (catalog.takesJoiners(preset)) return stageService.results(run);
    // One last count first, so the final seconds are in it.
    await server.sayAll(commands.scoreTick(preset));
    if (preset.kind === "gathering") {
        await server.sayAll(
            gather.gatheringTick(
                gather.materialOf(run.material, preset.options as catalog.EventOptions<"gathering">)
            )
        );
    }
    if (preset.kind === "waves" && run.place) {
        const options = preset.options as catalog.EventOptions<"waves">;
        await server.sayAll(
            waves.wavesTick(
                run.place,
                options.mix,
                run.roundEndsAt !== null,
                options.winner === "damage"
            )
        );
    }
    if (preset.kind === "meteor-shower") {
        const ores = (preset.options as catalog.EventOptions<"meteor-shower">).ores;
        await server.sayAll(meteors.meteorTick(run.meteors, ores));
    }
    if (preset.kind === "world-boss") await server.sayAll(commands.bossDamageTick());
    const scores = commands.readScores(await server.say([commands.READ_SCORES]));
    const known = new Set([...scores.keys()].map((name) => name.toLowerCase()));
    for (const name of run.participants) {
        if (known.has(name.toLowerCase()) || !catalog.PLAYER_NAME.test(name)) continue;
        for (const [who, score] of commands.readScores(
            await server.say([commands.readScoreCommand(name)])
        )) {
            scores.set(who, score);
        }
    }
    if (preset.kind === "waves") {
        // Took part: at the point when a wave ended, and fought - a kill, or
        // at least a hit - rather than only stood there.
        const hits = commands.readScores(await server.say([waves.READ_HITS]));
        const held = (name: string) =>
            Object.entries(run.survived).some(
                ([who, count]) => who.toLowerCase() === name.toLowerCase() && count > 0
            );
        const fought = (name: string) =>
            [...scores, ...hits].some(
                ([who, value]) => who.toLowerCase() === name.toLowerCase() && value > 0
            );
        return { scores, took: run.participants.filter((name) => held(name) && fought(name)) };
    }
    if (preset.kind === "blood-moon") {
        const alive = new Set((await survivorsOf(server, run)).map((name) => name.toLowerCase()));
        // Taking part is fighting through the night and seeing the dawn: alive
        // and at least one kill. Somebody who sat it out indoors saw the dawn
        // too, and was being handed the prize for it.
        for (const name of [...scores.keys()])
            if (!alive.has(name.toLowerCase())) scores.delete(name);
    }
    return {
        scores,
        took: [...scores.entries()].filter(([, score]) => score > 0).map(([name]) => name)
    };
}

/** Everybody on at dawn who did not die during the night. */
async function survivorsOf(server: ServerContainer, run: stored.EventRun): Promise<string[]> {
    // In the Overworld at dawn: sitting the night out in the Nether is not
    // surviving it.
    const on = commands.readWhere(await server.say([commands.IN_OVERWORLD])).map((one) => one.name);
    const deaths = commands.readDeaths(await server.say([commands.READ_DEATHS]));
    const took = new Set(run.participants.map((name) => name.toLowerCase()));
    return on.filter((name) => took.has(name.toLowerCase()) && (deaths.get(name) ?? 0) === 0);
}

/**
 * Who the anti-cheat caught while the event ran: a honeypot dug to, or an alert
 * from Polaris's own engine. Kept off the podium and out of the prizes.
 */
async function disqualifiedSince(installedAppId: string, since: number): Promise<Set<string>> {
    const found = new Set<string>();
    const row = await readRow(installedAppId);
    if (row) {
        for (const evidence of Object.values(readXray(row.config).evidence)) {
            if (evidence.hits.some((hit) => hit.at >= since))
                found.add(evidence.name.toLowerCase());
        }
    }
    const flagged = await prisma.minecraftAnticheatFlag
        .groupBy({ by: ["player"], where: { installedAppId, at: { gte: new Date(since) } } })
        .catch(() => []);
    for (const one of flagged) found.add(one.player.toLowerCase());
    return found;
}

/**
 * Hand one player their prize (`delivery.deliver`): what arrived, what fell at
 * their feet for want of room - each told so, in their own language - and what
 * the game did not take at all, to be kept for later. Never what it took, which
 * would then be given twice.
 */
async function give(
    server: ServerContainer,
    name: string,
    reward: catalog.Reward
): Promise<{ left: catalog.Reward | null; delivered: stored.DeliveredPrize }> {
    const handed = await delivery.deliver((line) => server.say([line]), name, reward);
    const told = delivery
        .droppedOf(handed.delivery)
        .map(
            (one) =>
                `tellraw ${name} ${commands.text(
                    messages.tag(speech.EVERY) +
                        messages.droppedAtFeet(one.dropped, one.label ?? one.id, speech.EVERY)
                )}`
        );
    if (told.length > 0) await server.sayAll(told);
    return {
        left: handed.left ? { items: [...handed.left.items], levels: handed.left.levels } : null,
        delivered: {
            name,
            items: handed.delivery.items.map((one) => ({
                id: one.id,
                count: one.count,
                dropped: one.dropped
            })),
            levels: handed.delivery.levels
        }
    };
}

const VERSION_LINE = "Starting minecraft server version [^ ]*";

/**
 * The version the server said it started as, out of its log; null when unread.
 *
 * The line is written once, when the server starts, and the log is rolled over
 * into `logs/<date>-<n>.log.gz` at the first midnight after that - so a server
 * that has been up since yesterday has no such line in `latest.log`. The newest
 * archive that has it is then this run's start: every start rolls the log over
 * too, so an older start is always in an older file.
 */
async function versionOf(server: ServerContainer): Promise<string | null> {
    const read = async (script: string) => {
        const result = await server.run(["sh", "-c", script]).catch(() => null);
        return /version (\S+)/.exec(result?.output ?? "")?.[1] ?? null;
    };
    return (
        (await read(`grep -m1 -o '${VERSION_LINE}' ${LOG_FILE}`)) ??
        (await read(
            `for f in $(ls -t ${LOG_DIR}/*.log.gz 2>/dev/null | head -n 60); do gzip -dc "$f" 2>/dev/null | grep -m1 -o '${VERSION_LINE}' && break; done`
        ))
    );
}

/**
 * Whether this server runs at least a version. Out of its log when it can be
 * read; when it cannot, the version is unknown - never taken for the newest -
 * and what the game itself answers to a harmless probe gives the lowest it can
 * be. Past what a probe can tell, the answer is no: every caller's older choice
 * is the one that works, or fails harmlessly, on a newer server too.
 */
async function serverAtLeast(server: ServerContainer, wanted: readonly number[]): Promise<boolean> {
    const version = await versionOf(server);
    if (version !== null) return atLeast(version, wanted);
    const ask = (line: string) => server.say([line]).catch(() => "");
    if (commands.probeParsed(await ask(commands.PROBE_COMPONENTS)))
        return atLeast("1.20.5", wanted);
    if (commands.commandKnown(await ask(commands.PROBE_ATTRIBUTE))) return atLeast("1.16", wanted);
    return false;
}

/** Whether a version is at least another. A snapshot is taken as recent; one
 *  that cannot be read at all as unknown, which is not at least anything. */
export function atLeast(version: string | null, wanted: readonly number[]): boolean {
    if (version === null) return false;
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
    if (!match) return true;
    const have = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
    for (let index = 0; index < wanted.length; index += 1) {
        const left = have[index] ?? 0;
        const right = wanted[index] ?? 0;
        if (left !== right) return left > right;
    }
    return true;
}

// ------------------------------------------------------------------ who is playing

/** Look at who is on and which way they are facing, and remember it. Null when
 *  the server is not running. */
async function sample(
    ownerId: string,
    installedAppId: string
): Promise<Map<string, plan.Seen> | null> {
    const loop = loops.get(installedAppId);
    if (loop?.link?.server.running) return playing.lookAt(installedAppId, loop.link.server);
    return withServerContainer(ownerId, installedAppId, async (server) =>
        server.running ? playing.lookAt(installedAppId, server) : null
    );
}

// ------------------------------------------------------------------ the sweep

/** Why there was nowhere to hold an event, as the history says it. */
export const NO_GROUND = "No dry ground was found for it near the players";
export const NO_AIR = "No open air was found for it near the players";
export const NOBODY_IN_OVERWORLD = "Nobody is in the Overworld to hold it near";

/**
 * When the sweep last looked at each server's draw. Kept in this process rather
 * than written down: it changes every minute, and what it is for - the screen
 * showing the draw is alive - is answered by the process that runs the sweep.
 */
const drawChecks = new Map<string, number>();

/** An event on while a drawn one is due: said, so the screen says why it waits. */
async function noteDrawBlocked(
    installedAppId: string,
    state: stored.EventState,
    now: number
): Promise<void> {
    drawChecks.set(installedAppId, now);
    if (state.nextRandomAt === null || now < state.nextRandomAt) return;
    const reason = gameMessage("minecraft", "events.waiting.anotherOn");
    if (state.waiting === reason) return;
    await updateEventState(installedAppId, (current) => ({ ...current, waiting: reason }));
}

/**
 * The minute sweep, for every Minecraft server with events set up: an event
 * that lost its loop to a restart gets it back, prizes waiting for somebody who
 * is on now are handed over, and a scheduled or drawn event whose moment has
 * come is started.
 */
export async function sweepEvents(now = Date.now()): Promise<{ running: number; started: number }> {
    const rows = await prisma.installedApp.findMany({
        where: { status: { not: "removed" }, catalogId: "minecraft" },
        select: { id: true, ownerId: true, config: true }
    });
    let started = 0;
    for (const row of rows) {
        const config = readInstallConfig(row.config);
        if (!(catalog.EVENTS_KEY in config) && !(catalog.EVENT_STATE_KEY in config)) continue;
        try {
            if (await sweepOne(row.ownerId, row.id, config, now)) started += 1;
        } catch (error) {
            console.warn("polaris: events sweep failed", row.id, String(error));
        }
    }
    return { running: loops.size, started };
}

async function sweepOne(
    ownerId: string,
    installedAppId: string,
    config: Record<string, unknown>,
    now: number
): Promise<boolean> {
    const settings = settingsOf(config);
    const state = stored.readEventState(config);
    // A parkour or spleef that ended with blocks still up or players still owed
    // their trip back: tried again every minute until it is all done.
    if (state.stageLeftovers.some((one) => one.runId !== state.run?.id)) {
        await settleStageLeftovers(ownerId, installedAppId, settings.settings.language).catch(
            (error: unknown) =>
                console.warn(
                    "polaris: undoing an event's arena failed",
                    installedAppId,
                    String(error)
                )
        );
    }
    // Arenas somebody is still to be taken back from, whatever else is on -
    // but not while an end is being handed out, which settles its own.
    if (state.arenaLeftovers.length > 0 && !loops.get(installedAppId)?.finishing) {
        await settleArenaLeftovers(
            ownerId,
            installedAppId,
            state.arenaLeftovers,
            settings.settings.language
        );
    }
    if (state.run) {
        if (settings.settings.random.enabled) await noteDrawBlocked(installedAppId, state, now);
        if (loops.has(installedAppId)) return false;
        if (state.run.finishing) await abandon(ownerId, installedAppId, state.run);
        else startLoop(ownerId, installedAppId, state.run, settings.settings);
        return false;
    }
    const pending = stored.livePending(state.pending, now);
    const wantsPlayers =
        pending.length > 0 ||
        settings.settings.random.enabled ||
        settings.schedules.some((entry) => entry.enabled);
    if (!wantsPlayers) return false;

    const seen = await sample(ownerId, installedAppId).catch(() => null);
    if (seen === null) {
        if (settings.settings.random.enabled) {
            drawChecks.set(installedAppId, now);
            const down = gameMessage("minecraft", "events.waiting.serverDown");
            if (state.waiting !== down)
                await updateEventState(installedAppId, (current) => ({ ...current, waiting: down }));
        }
        return false;
    }
    if (pending.length > 0 && seen.size > 0) await deliverPending(ownerId, installedAppId, seen);
    const active = plan.activePlayers(seen, settings.settings.afkMinutes, now).length;
    const activeFor = (preset: catalog.EventPreset) =>
        plan.playersFor(preset, seen, settings.settings.afkMinutes, now).length;
    const busy = plan.busyReason(seen, settings.settings.afkMinutes, now);

    // A time on the schedule first: somebody chose it.
    const due = plan.schedulesDue(settings.settings, settings.schedules, state.scheduleRuns, now);
    // Still due a minute from now: a fight can be waited out that long.
    const stillDue = new Set(
        plan
            .schedulesDue(settings.settings, settings.schedules, state.scheduleRuns, now + 60_000)
            .map((entry) => entry.id)
    );
    for (const entry of due) {
        const preset = settings.presets.find((one) => one.id === entry.presetId);
        if (!preset) continue;
        // Somebody fighting: the event waits a minute at a time within its
        // few minutes' grace, and is skipped only if the fight outlasts them.
        if (busy && stillDue.has(entry.id)) {
            await updateEventState(installedAppId, (current) => ({
                ...current,
                waiting: gameMessage("minecraft", "events.waiting.busyNow", { reason: busy })
            }));
            continue;
        }
        await updateEventState(installedAppId, (current) => ({
            ...current,
            scheduleRuns: { ...current.scheduleRuns, [entry.id]: now }
        }));
        if (busy) {
            await skip(installedAppId, preset, "scheduled", `Skipped: ${english(busy)}`);
            continue;
        }
        const needed = catalog.activeNeeded(preset, settings.settings);
        const ready = activeFor(preset);
        if (ready < needed) {
            const where = catalog.needsOverworld(preset) ? " in the Overworld" : "";
            await skip(
                installedAppId,
                preset,
                "scheduled",
                `Skipped: ${ready} active${where} of the ${needed} it waits for`
            );
            continue;
        }
        try {
            await startEvent({
                ownerId,
                installedAppId,
                presetId: preset.id,
                trigger: "scheduled",
                startedBy: null
            });
            return true;
        } catch (error) {
            await skip(
                installedAppId,
                preset,
                "scheduled",
                `Skipped: ${error instanceof Error ? english(error.message) : "it could not start"}`
            );
        }
    }

    const decision = plan.decideRandom({
        settings: settings.settings,
        presets: settings.presets,
        nextRandomAt: state.nextRandomAt,
        lastKind: state.lastKind,
        running: false,
        active,
        activeFor,
        busy,
        short: state.short,
        readySince: state.readySince,
        now,
        random: Math.random
    });
    if (settings.settings.random.enabled) drawChecks.set(installedAppId, now);
    // Kept across a wait for something else (an event on, the hours): only the
    // players it waits for, or a start, settle it.
    const short = decision.start ? false : (decision.short ?? state.short);
    const readySince = decision.start
        ? null
        : decision.short === undefined
          ? state.readySince
          : (decision.readySince ?? null);
    // Written only when something changed: the sweep comes round every minute.
    if (
        state.nextRandomAt !== decision.nextRandomAt ||
        state.waiting !== decision.waiting ||
        state.short !== short ||
        state.readySince !== readySince
    )
        await updateEventState(installedAppId, (current) => ({
            ...current,
            nextRandomAt: decision.nextRandomAt,
            waiting: decision.waiting,
            short,
            readySince
        }));
    if (!decision.start) return false;
    try {
        await startEvent({
            ownerId,
            installedAppId,
            presetId: decision.start.id,
            trigger: "random",
            startedBy: null
        });
        return true;
    } catch (error) {
        await updateEventState(installedAppId, (current) => ({
            ...current,
            waiting:
                error instanceof Error
                    ? error.message
                    : gameMessage("minecraft", "events.waiting.couldNotStart")
        }));
        return false;
    }
}

/** Every arena left from an event that is over, settled as far as it can be now. */
async function settleStageLeftovers(
    ownerId: string,
    installedAppId: string,
    language: catalog.Language
): Promise<void> {
    const settled = await withServerContainer(ownerId, installedAppId, async (server) => {
        if (!server.running) return null;
        const current = stored.readEventState((await readRow(installedAppId))?.config ?? {});
        const due = current.stageLeftovers.filter((one) => one.runId !== current.run?.id);
        if (due.length === 0) return null;
        const flavour = await stageFlavour(server);
        const after = new Map<string, stage.Leftover | null>();
        for (const one of due) {
            const spared = chunks.sparing(server, () => chunks.heldBefore(one));
            after.set(one.runId, await stageService.settle(spared, one, flavour, language));
        }
        return after;
    });
    if (!settled) return;
    await updateEventState(installedAppId, (state) => ({
        ...state,
        stageLeftovers: state.stageLeftovers.flatMap((one) => {
            if (!settled.has(one.runId)) return [one];
            const rest = settled.get(one.runId);
            return rest ? [rest] : [];
        })
    }));
}

async function skip(
    installedAppId: string,
    preset: catalog.EventPreset,
    trigger: stored.EventTrigger,
    note: string
): Promise<void> {
    const now = Date.now();
    await updateEventState(installedAppId, (state) =>
        stored.withHistory(state, {
            id: `${now.toString(36)}-skip`,
            presetId: preset.id,
            kind: preset.kind,
            name: preset.name,
            trigger,
            outcome: "skipped",
            note,
            startedAt: now,
            endedAt: now,
            participants: 0,
            podium: [],
            disqualified: [],
            delivered: [],
            search: null
        })
    );
}

/** Prizes handed to whoever is owed one and is on now. */
async function deliverPending(
    ownerId: string,
    installedAppId: string,
    seen: ReadonlyMap<string, plan.Seen>
): Promise<void> {
    const row = await readRow(installedAppId);
    if (!row) return;
    const owed = stored
        .livePending(stored.readEventState(row.config).pending, Date.now())
        .filter((one) => seen.has(one.player.toLowerCase()));
    if (owed.length === 0) return;
    /** What is still owed after this, by pending id: null when all of it arrived. */
    const left = new Map<string, catalog.Reward | null>();
    /** What reached whom, for the history of the run it was won in. */
    const arrived: { runId: string; prize: stored.DeliveredPrize }[] = [];
    // Each told in their own language.
    const language = speech.EVERY;
    const home = await speechService.homeLanguage(ownerId, catalog.chosenLanguage(row.config));
    homes.set(installedAppId, home);
    await withServerContainer(ownerId, installedAppId, async (server) => {
        if (!server.running) return;
        await speechService.hear(installedAppId, server, home);
        for (const one of owed) {
            if (!catalog.PLAYER_NAME.test(one.player)) continue;
            const handed = await give(server, one.player, one.reward);
            const rest = handed.left;
            arrived.push({
                runId: one.id.slice(0, -(one.player.length + 1)),
                prize: handed.delivered
            });
            if (!rest) {
                left.set(one.id, null);
                await server.say([
                    `tellraw ${one.player} ${commands.text(messages.rewardGiven(one.event, language))}`
                ]);
            } else if (
                rest.items.length !== one.reward.items.length ||
                rest.levels !== one.reward.levels
            ) {
                left.set(one.id, rest);
            }
        }
    });
    if (left.size === 0 && arrived.length === 0) return;
    await updateEventState(installedAppId, (current) => ({
        ...current,
        pending: current.pending.flatMap((one) => {
            if (!left.has(one.id)) return [one];
            const rest = left.get(one.id);
            return rest ? [{ ...one, reward: rest }] : [];
        }),
        // Written into the run it was won in, when that is still in the history.
        history: current.history.map((entry) => {
            const more = arrived.filter((one) => one.runId === entry.id).map((one) => one.prize);
            return more.length > 0 ? { ...entry, delivered: [...entry.delivered, ...more] } : entry;
        })
    }));
}

/** For a test: forget what was seen of every server's players, as a fresh
 *  process has. A test clock that starts over would otherwise meet a fight
 *  recorded "later" by the test before it. */
export function forgetPlayers(): void {
    playing.forgetActivity();
    bukkitServers.clear();
}

/** For a test: what the loops hold. */
export function runningEvents(): string[] {
    return [...loops.keys()];
}
