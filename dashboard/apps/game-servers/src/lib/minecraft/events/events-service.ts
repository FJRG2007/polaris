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
import { prisma } from "@polaris/db";
import * as catalog from "./catalog";
import * as replies from "./replies";
import * as service from "../service";
import * as waves from "./kinds/waves";
import * as commands from "./commands";
import * as speech from "../speech";
import * as speechService from "../speech-service";
import * as delivery from "../delivery";
import * as written from "./messages";
import * as stage from "./kinds/stage";
import * as playing from "../activity";
import * as trivia from "./trivia-bank";
import * as chunks from "./kinds/chunks";
import { host } from "@polaris/app-host";
import * as duel from "./kinds/team-duel";
import * as boost from "./kinds/xp-boost";
import { parseProperties } from "../parse";
import { readSchedule } from "../schedule";
import { withTimeout } from "@polaris/core";
import * as gather from "./kinds/gathering";
import * as hunt from "./kinds/treasure-hunt";
import * as rareCatch from "./kinds/rare-catch";
import * as meteors from "./kinds/meteor-shower";
import * as stageService from "./kinds/stage-service";
import * as parkour from "./kinds/parkour";
import * as arenaService from "./kinds/arena-service";
import * as stashService from "./kinds/stash-service";
import { editionOf, type ServerContainer } from "../service";
import { holdSidebar, releaseSidebar } from "../live-display-service";
import { containerFileSize, readContainerFile, readContainerRange } from "../../container-files";

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
        sayAll: async (lines) =>
            server.sayAll(await named(speech.localizeAll(lines, audience())))
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
    /** Parkour: the quick look at falls and checkpoints, far oftener than the tick. */
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
    /** World boss: where it was last seen standing. */
    bossAt: stored.Point | null;
    /** World boss: its health at the last look, to tell what it lost since. */
    bossHealth: number | null;
    /** How this server writes a name into an entity, and its attribute ids. */
    modern: { ids: boolean } | null;
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
    throw new Error("The server's settings kept changing while this was saved. Try again.");
}

/** Save the events set up on the screen. Checked again here: this is the one
 *  that decides. */
export async function saveEventsConfig(
    installedAppId: string,
    input: unknown
): Promise<catalog.EventsConfig> {
    const parsed = catalog.eventsConfigSchema.safeParse(input);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Check the events");
    const value = parsed.data;
    for (let attempt = 0; attempt < WRITE_TRIES; attempt += 1) {
        const row = await prisma.installedApp.findUnique({
            where: { id: installedAppId },
            select: { config: true, status: true }
        });
        if (!row || row.status === "removed") throw new Error("That server is not here");
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
    throw new Error("The server's settings kept changing while this was saved. Try again.");
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
    /** Who is on and who of them is playing, as the last look saw them. Null when
     *  nobody has looked yet. */
    readonly players: { readonly online: number; readonly active: number } | null;
    readonly refusal: string | null;
}

export async function eventsView(installedAppId: string): Promise<EventsView> {
    const row = await readRow(installedAppId);
    if (!row) throw new Error("That server is not here");
    const config = settingsOf(row.config);
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
    if (!row) throw new Error("That server is not here");
    if (editionOf(row.catalogId) === "bedrock") {
        throw new Error("Events run on Java servers only");
    }
    const config = settingsOf(row.config);
    const preset = config.presets.find((one) => one.id === input.presetId);
    if (!preset) throw new Error("That event no longer exists");
    if (!preset.enabled && input.trigger !== "manual")
        throw new Error("That event is switched off");

    const seen = await sample(row.ownerId, input.installedAppId);
    if (seen === null) throw new Error("The server is not running");
    if (seen.size === 0) throw new Error("Nobody is on the server");
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
        const where = catalog.needsOverworld(preset) ? " in the Overworld" : "";
        throw new Error(
            `Only ${active} of the ${seen.size} players on are active${where}; this event waits for ${needed}`
        );
    }
    if (input.trigger !== "manual") {
        const busy = plan.busyReason(seen, config.settings.afkMinutes, Date.now());
        if (busy) throw new Error(`Not now: ${busy}`);
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
            throw new Error(
                "The server is on Peaceful, where hostile mobs vanish as soon as they appear. Set the difficulty to Easy or harder under Rules first."
            );
        }
    }
    // Players who cannot hurt each other have nothing to duel with. Read from
    // the server's own settings file, which is what the game goes by.
    if (catalog.needsPvp(preset)) {
        const properties = await withServerContainer(row.ownerId, input.installedAppId, (server) =>
            readContainerFile(server, SERVER_PROPERTIES)
        ).catch(() => null);
        if (properties !== null && parseProperties(properties).pvp === "false") {
            throw new Error(
                "Player versus player is Blocked on this server, and a duel needs it. Allow it under Settings first."
            );
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
                `${catalog.KIND_INFO[preset.kind].label} needs Minecraft 1.16 or later, and this server runs an older one.`
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
        chests: [],
        held: [],
        hidden: false,
        origin: null,
        material:
            preset.kind === "gathering"
                ? gather.drawMaterial(
                      preset.options as catalog.EventOptions<"gathering">,
                      Math.random
                  )
                : null,
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
        marker: null,
        kit: [],
        readyAt: null,
        tally: {},
        votes: {},
        theme: null,
        voting: false
    } satisfies stored.EventRun;

    const stored = await updateEventState(input.installedAppId, (state) => {
        if (state.run) throw new Error("Another event is on. Let it finish or cancel it first.");
        return { ...state, run, waiting: null };
    });
    if (!stored) throw new Error("That server is not here");
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
    if (!state?.run) throw new Error("No event is on");
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
    if (!state?.run || state.run.cancelled) throw new Error("No event is on");
    if (state.run.phase !== "countdown") throw new Error("It has already started");
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
export async function retryStash(installedAppId: string, id: string): Promise<stashService.GiveBack> {
    const row = await readRow(installedAppId);
    if (!row) throw new Error("That server is not here");
    return withServerContainer(row.ownerId, installedAppId, async (server) => {
        if (!server.running) return "offline" as const;
        return stashService.retryStash(server, installedAppId, id);
    });
}

/** Taken off the panel: the operator has dealt with it. */
export async function dismissStash(installedAppId: string, id: string): Promise<void> {
    await stashService.dismissStash(installedAppId, id);
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
        bossAt: null,
        bossHealth: null,
        modern: null,
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
        quiet: false
    };
    loop.timer.unref?.();
    loop.clock = setInterval(() => void showClock(loop), CLOCK_MS);
    loop.clock.unref?.();
    if (run.preset.kind === "parkour") {
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
                commands.barColour(preset.kind)
            ),
            ...commands.titleCommands(messages.startsSoonTitle(language), `&e${title}`),
            commands.say(messages.tag(language) + messages.startsIn(title, left, language)),
            commands.say(
                `${messages.tag(language)}&f${messages.rules(preset.kind, language, isRace(preset))}`
            ),
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
 * Parkour's quick look (`stageService.quickLines`): one batch, nothing read,
 * never two at once, and nothing while the tick has no connection open.
 */
async function quickLook(loop: Loop): Promise<void> {
    const server = loop.link?.server;
    if (!server || loop.finishing || loop.quickBusy || loop.run.phase !== "running") return;
    const lines = stageService.quickLines(loop);
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

/** What a gathering or a rare catch is for, said with the rules. */
function targetLines(run: stored.EventRun, language: speech.Speech): string[] {
    const { preset } = run;
    if (preset.kind === "gathering") {
        const material = gather.materialOf(
            run.material,
            preset.options as catalog.EventOptions<"gathering">
        );
        return [commands.say(messages.tag(language) + messages.gatherTarget(material, language))];
    }
    if (preset.kind === "rare-catch") {
        const { treasure } = preset.options as catalog.EventOptions<"rare-catch">;
        return [commands.say(messages.tag(language) + messages.catchTarget(treasure, language))];
    }
    return [];
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
            commands.barColour(preset.kind)
        ),
        ...commands.setupScoreboard(preset, `&6&l${preset.name}`),
        ...commands.titleCommands(messages.startedTitle(language), `&e${preset.name}`),
        commands.say(messages.tag(language) + `&e&l${preset.name}`),
        commands.say(
            `${messages.tag(language)}&f${messages.rules(preset.kind, language, isRace(preset))}`
        ),
        ...targetLines(loop.run, language),
        commands.say(messages.tag(language) + messages.lasts(catalog.runMinutes(preset), language)),
        commands.sound(preset.kind === "blood-moon" ? commands.SOUNDS.horn : commands.SOUNDS.start)
    ];
    if (preset.kind === "gathering") {
        // Counted from now: what everybody holds at this moment is where they start.
        const material = gather.materialOf(
            loop.run.material,
            preset.options as catalog.EventOptions<"gathering">
        );
        lines.push(...gather.gatheringSetup(material), ...gather.gatheringTick(material));
    }
    if (preset.kind === "rare-catch") {
        lines.push(...rareCatch.catchSetup(preset.options as catalog.EventOptions<"rare-catch">));
    }
    if (preset.kind === "xp-boost") {
        lines.push(...boost.boostSetup(preset.options as catalog.EventOptions<"xp-boost">));
    }
    if (preset.kind === "world-boss") {
        lines.push(
            ...commands.bossScoreboard((preset.options as catalog.EventOptions<"world-boss">).boss)
        );
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
    if (catalog.keepsDay(preset)) {
        // Day held still, and no phantoms, for as long as it runs: what each
        // rule was is written down before it is changed, so whatever ends it -
        // a restart included - puts back exactly that.
        const before: Record<string, string> = {};
        for (const names of commands.DAY_RULES) {
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
        loop.run = { ...loop.run, gamerules: { ...before, ...loop.run.gamerules } };
        await persist(installedAppId, loop);
        lines.push(commands.MIDDAY);
    }
    if (catalog.needsPvp(preset)) {
        // Nobody loses what they carry to a fight: a death keeps all of it, for
        // exactly as long as the duel lasts, and the rule is put back after.
        const before: Record<string, string> = {};
        for (const rule of duel.KEEP_INVENTORY) {
            const value = commands.readRuleValue(await server.say([commands.readRule(rule)]));
            if (value === null) continue;
            before[rule] = value;
            lines.push(commands.setRule(rule, "true"));
            break;
        }
        // A rule it cannot read is one it cannot hold or give back: no fight.
        if (Object.keys(before).length === 0) {
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
    // shows its health and a horde defence's the wave.
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
            decided = await worldBoss(installedAppId, loop, server, now, lines);
            break;
        case "king-of-the-hill":
            decided = await kingOfTheHill(installedAppId, loop, server, lines);
            break;
        case "explorer":
            if (isRace(preset)) decided = await race(installedAppId, loop, server, lines);
            break;
        case "trivia":
            decided = await triviaTick(installedAppId, loop, server, now, lines);
            break;
        case "treasure-hunt":
            decided = await treasureHunt(installedAppId, loop, server, now, lines);
            break;
        case "gathering":
            await gathering(loop, server, lines);
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
            decided = await hordeDefence(installedAppId, loop, server, now, lines);
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
    asGiven = true
): Promise<stored.Point | "failed" | null> {
    const chosen = asGiven && place.mode === "fixed" && loop.run.placeTries === 0;
    if (!loop.run.target) {
        const centre = await centreFor(server, place);
        if (!centre) return "failed";
        let point: { x: number; z: number } | null = centre;
        if (!chosen) {
            const [spawnX, spawnZ, respawn, spawnWorld, respawnWorld] = await Promise.all(
                commands.HOMES.map((line) => server.say([line]).catch(() => ""))
            );
            const homes = commands.readHomes(
                spawnX ?? "",
                spawnZ ?? "",
                respawn ?? "",
                spawnWorld ?? "",
                respawnWorld ?? ""
            );
            point = commands.clearPoint(centre, distance, homes, Math.random, clearance);
        }
        if (!point) {
            loop.run = { ...loop.run, placeTries: loop.run.placeTries + 1 };
            await persist(installedAppId, loop);
            return loop.run.placeTries >= PLACE_TRIES ? "failed" : null;
        }
        // Written down before the chunk is loaded, so whatever ends the event
        // knows which one to let go of.
        loop.run = { ...loop.run, target: { x: point.x, z: point.z } };
        await persist(installedAppId, loop);
        await server.sayAll([commands.forceload(point.x, point.z)]);
        return null;
    }
    const { x, z } = loop.run.target;
    let landed: stored.Point | null = null;
    if (await dropMark(server, x, z)) {
        const point = commands.readPoint(await server.say([commands.READ_MARK]));
        landed = point;
        if (point && (chosen || (await siteIsOpen(loop, server, point, radius)))) {
            // The marker can come down a block or two from the column tried - an
            // older server spreads it - and so in the next chunk: that chunk is
            // the one held from now on, and the one tried let go of.
            const moved = !commands.sameChunk(point, { x, z });
            if (moved) await server.sayAll([commands.forceload(point.x, point.z)]);
            loop.run = { ...loop.run, place: point, target: { x: point.x, z: point.z } };
            await persist(installedAppId, loop);
            if (moved) await server.sayAll([commands.forceloadRemove(x, z)]);
            return point;
        }
    }
    await server.sayAll([
        commands.CLEAR_MARK,
        commands.forceloadRemove(x, z),
        // Judging the ground holds the chunk the marker came down in, which
        // need not be the column's.
        ...(landed && !commands.sameChunk(landed, { x, z })
            ? [commands.forceloadRemove(landed.x, landed.z)]
            : [])
    ]);
    loop.run = { ...loop.run, target: null, placeTries: loop.run.placeTries + 1 };
    await persist(installedAppId, loop);
    return loop.run.placeTries >= PLACE_TRIES ? "failed" : null;
}

/**
 * Whether the ground over the whole of a place is the world's own and walkable:
 * every sampled column dry, within a few blocks of the centre's height, and on
 * nothing anybody built. Leaves the marker back on the centre, where whatever
 * the event puts down is put.
 */
async function siteIsOpen(
    loop: Loop,
    server: ServerContainer,
    centre: stored.Point,
    radius: number
): Promise<boolean> {
    const reach = radius + 1;
    const area = `${centre.x - reach} ${centre.z - reach} ${centre.x + reach} ${centre.z + reach}`;
    await server.sayAll([`execute in minecraft:overworld run forceload add ${area}`]);
    let open = true;
    try {
        const samples = commands.siteSamples(centre, radius);
        let rough = 0;
        for (const [index, sample] of samples.entries()) {
            const ground = (await dropMark(server, sample.x, sample.z))
                ? commands.readPoint(await server.say([commands.READ_MARK]))
                : null;
            // Water or lava where the game would not put the marker down: never
            // somewhere to stand, and never allowed at the centre.
            let fine = ground !== null && Math.abs(ground.y - centre.y) <= commands.SITE_STEP;
            if (ground && (await builtOn(loop, server, ground)) === true) {
                // A tree is rough ground; anything else - a build, water - is not
                // somewhere to put anything.
                let tree = false;
                for (const line of commands.treeUnder(ground)) {
                    if (commands.readTest(await server.say([line])) === "passed") tree = true;
                }
                if (!tree) {
                    open = false;
                    break;
                }
                fine = false;
            }
            if (fine) continue;
            rough += 1;
            if (index === 0 || rough > commands.roughAllowed(samples.length)) {
                open = false;
                break;
            }
        }
    } finally {
        // The area let go, and the centre's own chunk held again as before.
        await server.sayAll([
            `execute in minecraft:overworld run forceload remove ${area}`,
            commands.forceload(centre.x, centre.z)
        ]);
        await dropMark(server, centre.x, centre.z);
    }
    return open;
}

/**
 * The marker on the ground at a column, under any trees - or, on a server too old
 * for the heightmap, wherever `spreadplayers` puts it. Answers whether it is down.
 */
async function dropMark(server: ServerContainer, x: number, z: number): Promise<boolean> {
    let output = "";
    for (const line of commands.markGround(x, z)) output = await server.say([line]);
    if (commands.groundWorked(output)) return true;
    for (const line of commands.markSurface(x, z)) output = await server.say([line]);
    if (!commands.spreadWorked(output)) return false;
    // Down through the crown and the trunk to the ground under them.
    await server.sayAll(commands.SETTLE_MARK);
    return true;
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
    point: stored.Point
): Promise<void> {
    await server.sayAll([commands.CLEAR_MARK, ...commands.release(point, loop.run.target)]);
    loop.run = { ...loop.run, place: null, target: null, placeTries: loop.run.placeTries + 1 };
    await persist(installedAppId, loop);
    if (loop.run.placeTries >= PLACE_TRIES) throw new PlaceNotFound();
}

/** Where to look from: the fixed point, or one of the players in the Overworld. */
async function centreFor(
    server: ServerContainer,
    place: catalog.EventPlace
): Promise<{ x: number; z: number } | null> {
    if (place.mode === "fixed") return { x: place.x, z: place.z };
    const here = commands.readWhere(await server.say([commands.IN_OVERWORLD]));
    if (here.length === 0) return null;
    const one = here[Math.floor(Math.random() * here.length)]!;
    return { x: Math.round(one.x), z: Math.round(one.z) };
}

// ------------------------------------------------------------------ each kind

/** What an event players join is lent for one tick: the loop's own tools. */
function kindContext(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    now: number
): arenaService.KindContext {
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
        findPlace: (place, distance, radius) =>
            findPlace(installedAppId, loop, server, place, distance, radius),
        giveUpPlace: (point) => retryPlace(installedAppId, loop, server, point),
        chat: () => chatSince(loop, server),
        atLeast: (wanted) => serverAtLeast(server, wanted),
        stashOwner: { installedAppId, runId: loop.run.id, event: loop.run.preset.name },
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
            SPOT_RADIUS
        );
        if (found === "failed") throw new PlaceNotFound();
        if (!found) return null;
        await server.sayAll([commands.placeChest(found, options.loot), commands.CLEAR_MARK]);
        // Placed, and unopened: a protected area or a plugin that refused the
        // block would otherwise read as a chest somebody already opened.
        if ((await chestTest(server, found)) !== "passed") {
            await retryPlace(installedAppId, loop, server, found);
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

async function worldBoss(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    now: number,
    lines: string[]
): Promise<string | null> {
    const options = loop.run.preset.options as catalog.EventOptions<"world-boss">;
    const language = loop.language;
    const name = messages.bossName(options.boss, language);
    if (!loop.run.place) {
        const found = await findPlace(installedAppId, loop, server, options.place, 24, SPOT_RADIUS);
        if (found === "failed") throw new PlaceNotFound();
        if (!found) return null;
        const modern = loop.modern ?? (loop.modern = await modernity(server));
        await server.sayAll(commands.summonBoss(options.boss, options.health));
        if (commands.readTest(await server.say([commands.BOSS_ALIVE])) !== "passed") {
            await retryPlace(installedAppId, loop, server, found);
            return null;
        }
        const other = commands.bossAttributes(options.health, !modern.ids);
        for (const [index, line] of commands.bossAttributes(options.health, modern.ids).entries()) {
            if (!commands.attributeWorked(await server.say([line]))) {
                await server.say([other[index] as string]);
            }
        }
        await server.sayAll([
            commands.bossHeal(options.health),
            // Both ways a name has been written, the older first: up to 1.21.4 the
            // newer is not a name at all and is passed over; from 1.21.5 the older
            // would show as its own text, and the newer replaces it.
            // Over its head, one name for everybody: the server's own language.
            commands.bossNameCommand(messages.bossName(options.boss, loop.home), false),
            commands.bossNameCommand(messages.bossName(options.boss, loop.home), true),
            commands.CLEAR_MARK,
            `bossbar set ${commands.BAR} max ${options.health}`,
            commands.say(
                messages.tag(language) +
                    messages.bossAppeared(name, found.x, found.y, found.z, language)
            ),
            commands.sound(commands.SOUNDS.boss)
        ]);
        return null;
    }
    const left = (loop.run.endsAt - now) / 1000;
    lines.push(
        `bossbar set ${commands.BAR} name ${commands.text(`&c${messages.barName(name, left)}`)}`,
        `bossbar set ${commands.BAR} players @a`,
        commands.bossBarHealth(),
        ...commands.bossDamageTick()
    );
    if (commands.readTest(await server.say([commands.BOSS_ALIVE])) !== "failed") {
        loop.bossAt = commands.readPoint(await server.say([commands.BOSS_WHERE])) ?? loop.bossAt;
        const health = commands.readHealth(await server.say([commands.BOSS_HEALTH]));
        if (health !== null) {
            await creditUnseen(server, loop.bossHealth === null ? 0 : loop.bossHealth - health, null);
            loop.bossHealth = health;
        }
        lines.push(commands.BOSS_KILLS_RESET);
        return null;
    }
    // Gone from the world: killed, if somebody where it was last seen has a
    // kill of its kind since then - otherwise it is only out of reach,
    // somewhere nobody is.
    const last = loop.bossAt ?? loop.run.place;
    const killers = commands
        .readWhere(await server.say([commands.BOSS_KILLERS]))
        .filter(
            (one) =>
                Math.hypot(one.x - last.x, one.y - last.y, one.z - last.z) <= commands.BOSS_REACH
        );
    if (killers.length === 0) return null;
    const by = killers[0]!.name;
    // The rest of its health went in its last moments: the final blows, counted
    // where it fell before anything else empties them.
    if (loop.bossAt) {
        await creditUnseen(server, loop.bossHealth ?? 0, loop.bossAt);
        await server.sayAll(commands.bossDamageAt(loop.bossAt));
        loop.bossHealth = 0;
    }
    loop.run = { ...loop.run, decidedBy: by };
    lines.push(commands.say(messages.tag(language) + messages.bossFell(name, by, language)));
    return `Defeated; the final blow by ${by}`;
}

/**
 * What the boss lost that nobody's melee accounts for - arrows, a trident, magic,
 * a mod's weapon, none of which the game's `damage_dealt` counts - shared evenly
 * among the players fighting near it (`commands.unseenShares`). `lost` is in
 * health points; `at` is where it fell, once it has.
 */
async function creditUnseen(
    server: ServerContainer,
    lost: number,
    at: stored.Point | null
): Promise<void> {
    // Shots that hit nothing are kept until something is lost: they did shoot.
    if (!(lost > 0)) return;
    const melee = commands.readScores(await server.say([commands.readRawNear(at)]));
    await server.sayAll(commands.SHOTS_SUMMED);
    const shooters = [...commands.readScores(await server.say([commands.readShootersNear(at)])).keys()];
    const shares = commands.unseenShares(lost * 10, melee, shooters);
    await server.sayAll([
        ...[...shares].map(([name, share]) => commands.shareLine(name, share)),
        ...commands.SHOTS_RESET
    ]);
}

async function kingOfTheHill(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    lines: string[]
): Promise<string | null> {
    const options = loop.run.preset.options as catalog.EventOptions<"king-of-the-hill">;
    if (!loop.run.place) {
        const found = await findPlace(
            installedAppId,
            loop,
            server,
            options.place,
            32,
            options.radius
        );
        if (found === "failed") throw new PlaceNotFound();
        if (!found) return null;
        await server.sayAll([
            commands.CLEAR_MARK,
            commands.say(
                messages.tag(loop.language) +
                    messages.circleAt(found.x, found.y, found.z, loop.language)
            )
        ]);
        return null;
    }
    const place = loop.run.place;
    lines.push(...commands.hillTick(place, options.radius, TICK_MS / 1000));
    // Each player told how far it is and which way, in their own action bar:
    // coordinates in the chat scroll away, and a circle is small from far off.
    for (const one of commands.readWhere(await server.say([commands.IN_OVERWORLD]))) {
        const away = Math.hypot(one.x - (place.x + 0.5), one.z - (place.z + 0.5));
        lines.push(
            commands.actionbarFor(
                one.name,
                commands.inHill(one, place, options.radius)
                    ? messages.hillInside(loop.language)
                    : messages.hillGuide(
                          Math.round(away),
                          commands.headingTo(one, { x: place.x + 0.5, z: place.z + 0.5 }),
                          loop.language
                      )
            )
        );
    }
    return null;
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
        const centre = await centreFor(server, options.place);
        if (!centre) throw new PlaceNotFound();
        const point = commands.pointAway(centre, options.distance, Math.random);
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
 * A treasure hunt's tick: the chests hidden first, a couple of tries a tick;
 * then the clues as they fall due, every chest checked for being opened, each
 * player pointed at the nearest one once they are close, and the beams in the
 * last minutes.
 */
async function treasureHunt(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    now: number,
    lines: string[]
): Promise<string | null> {
    const options = loop.run.preset.options as catalog.EventOptions<"treasure-hunt">;
    const language = loop.language;
    if (!loop.run.hidden) {
        await hideTreasure(installedAppId, loop, server, options);
        if (!loop.run.hidden) {
            lines.push(
                ...hunt.holdChests(loop.run.held),
                `title @a actionbar ${commands.text(messages.huntHiding(language))}`
            );
            return null;
        }
    }
    lines.push(...hunt.holdChests(loop.run.held));
    const total = (loop.run.endsAt - loop.run.startsAt) / 1000;
    const left = (loop.run.endsAt - now) / 1000;
    const due = hunt.clueDue((total - left) / Math.max(1, total));
    if (loop.run.reveals < due && loop.run.origin) {
        for (const line of hunt.clues(loop.run.chests, due, loop.run.origin, language)) {
            lines.push(commands.say(messages.tag(language) + line));
        }
        lines.push(commands.sound(commands.SOUNDS.tick));
        loop.run = { ...loop.run, reveals: due };
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
    if (unopened.length === 0) {
        return `All ${chests.length} ${chests.length === 1 ? "treasure" : "treasures"} found`;
    }

    if (hunt.beamsOn(left, total)) {
        if (loop.run.reveals < 4) {
            lines.push(commands.say(messages.tag(language) + messages.huntBeams(language)));
            loop.run = { ...loop.run, reveals: 4 };
        }
        for (const chest of unopened) lines.push(commands.beam(chest));
    }
    const players = commands.readWhere(await server.say([commands.IN_OVERWORLD]));
    lines.push(...hunt.guides(players, chests, language));
    return null;
}

/**
 * Hide the chests, one place at a time, each through `findPlace` - so on dry,
 * open, natural ground away from every bed - and only into air. A place that
 * will not take one is given up for another; when no more can be found, the hunt
 * goes on with the ones that are down, and fails only if none are.
 */
async function hideTreasure(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    options: catalog.EventOptions<"treasure-hunt">
): Promise<void> {
    if (!loop.run.origin) {
        const origin = hunt.centreOf(commands.readWhere(await server.say([commands.IN_OVERWORLD])));
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
    // Two steps a tick: a column chosen, then the ground there judged.
    for (let step = 0; step < 2 && !loop.run.hidden; step += 1) {
        const found = await findPlace(
            installedAppId,
            loop,
            server,
            { mode: "players" },
            hunt.huntDistance(options, Math.random),
            SPOT_RADIUS
        );
        if (found === "failed") return enough();
        if (!found) continue;
        const target = loop.run.target;
        let placed = false;
        // Air first, so a chest that was already there is never counted as
        // one of the hunt's - and never taken away at the end.
        const air =
            !hunt.tooClose(found, loop.run.chests) &&
            commands.readTest(await server.say([hunt.airAt(found)])) === "passed";
        const before = { chests: loop.run.chests, held: loop.run.held };
        if (air) {
            // Written down before it is placed, so whatever ends the event
            // takes it away again.
            loop.run = {
                ...loop.run,
                chests: [...before.chests, { ...found, opened: false, by: null }],
                held: [...before.held, ...(target ? [target] : []), { x: found.x, z: found.z }]
            };
            await persist(installedAppId, loop);
            await server.sayAll([hunt.hideChest(found, options.loot), commands.CLEAR_MARK]);
            // Down, and unopened: a protected area that refused the block reads
            // as nothing there.
            placed = (await chestTest(server, found)) === "passed";
        }
        if (!placed) {
            // Given up without taking the chunks of the chests already down.
            await server.sayAll([
                ...(air ? commands.removeChestLines(found) : []),
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
            if (loop.run.placeTries >= PLACE_TRIES) return enough();
            continue;
        }
        loop.run = {
            ...loop.run,
            place: null,
            target: null,
            placeTries: 0,
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
        await server.sayAll(commands.removeChestLines(last));
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

/** A gathering's tick: everybody's count brought up to date, and shown to them. */
async function gathering(loop: Loop, server: ServerContainer, lines: string[]): Promise<void> {
    const options = loop.run.preset.options as catalog.EventOptions<"gathering">;
    const material = gather.materialOf(loop.run.material, options);
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
    const each = Object.fromEntries(speech.LANGUAGES.map((one) => [one, roundIn(run, one)])) as Record<
        catalog.Language,
        ReturnType<typeof roundIn>
    >;
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
                messages.tag(language) +
                    messages.roundWon(winner, asked.answer, language)
            ),
            commands.sound(commands.SOUNDS.win)
        );
        await persist(installedAppId, loop);
        return null;
    }
    if (now >= (loop.run.roundEndsAt ?? now)) {
        loop.run = { ...loop.run, roundEndsAt: null, closedAt: now };
        lines.push(
            ...commands.titleCommands(
                messages.roundMissedTitle(language),
                `&f${asked.answer}`
            ),
            commands.say(
                messages.tag(language) + messages.roundMissed(asked.answer, language)
            )
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

// ------------------------------------------------------------------ horde defence

/**
 * A horde defence: the point found and marked, then wave after wave summoned
 * round it once somebody is there to meet it. A wave ends when none of its
 * monsters is left, or when its time is up (what is left of it is taken away);
 * whoever is at the point then has held it. Decided when the last wave ends.
 */
async function hordeDefence(
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
            waves.DEFENCE_RADIUS,
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
        ...waves.wavesTick(place, options.mix, open)
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
                ...(cleared ? [] : [`kill @e[tag=${commands.MOB_TAG}]`]),
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
                    (loop.run.endsAt - now) / 1000 + 60
                ),
                ...commands.titleCommands(
                    messages.waveTitle(wave + 1, options.waves, language),
                    messages.waveSubtitle(count, language)
                ),
                commands.sound(commands.SOUNDS.horn)
            );
        }
    }

    // Where the defence stands, on the bar and at the point; the way to it
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
        const centre = { x: place.x + 0.5, z: place.z + 0.5 };
        const away = Math.hypot(one.x - centre.x, one.z - centre.z);
        lines.push(
            commands.actionbarFor(
                one.name,
                away <= waves.AREA
                    ? status
                    : messages.wavesGuide(
                          Math.round(away),
                          commands.headingTo(one, centre),
                          language
                      )
            )
        );
    }
    return null;
}

// ------------------------------------------------------------------ meteor shower

/**
 * A meteor shower: the meteors brought down one after another over the first
 * part of the event, each where `findPlace` finds open ground, then raced to.
 * A meteor with a player near it is looked at block by block, and any block no
 * longer its ore is forgotten for good. Decided once every meteor is down and
 * mined out.
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
    const share = (now - loop.run.startsAt) / Math.max(1, loop.run.endsAt - loop.run.startsAt);
    if (loop.run.landings < meteors.dueMeteors(share, options.meteors)) {
        const found = await findPlace(
            installedAppId,
            loop,
            server,
            options.place,
            options.distance,
            meteors.RADIUS,
            commands.HOME_CLEARANCE,
            false
        );
        if (found === "failed") {
            // Nowhere for this one: it is let go, and the next looked for afresh.
            loop.run = { ...loop.run, landings: loop.run.landings + 1, placeTries: 0 };
            await persist(installedAppId, loop);
        } else if (found) {
            await landMeteor(installedAppId, loop, server, found, options);
        }
    }

    // Whatever of a meteor somebody near it has mined is forgotten: it is no
    // longer the event's to take away, whatever is put there after.
    let emptied = 0;
    const checked: stored.EventRun["meteors"] = [];
    for (const meteor of loop.run.meteors) {
        const near =
            meteor.blocks.length > 0 &&
            commands.readTest(await server.say([meteors.playerNear(meteor)])) === "passed";
        if (!near) {
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
    // Each player pointed at the latest meteor still to mine.
    const latest = live.at(-1);
    for (const one of commands.readWhere(await server.say([commands.IN_OVERWORLD]))) {
        if (!latest) {
            lines.push(commands.actionbarFor(one.name, messages.meteorWaiting(language)));
            continue;
        }
        const centre = { x: latest.x + 0.5, z: latest.z + 0.5 };
        lines.push(
            commands.actionbarFor(
                one.name,
                messages.meteorGuide(
                    Math.round(Math.hypot(one.x - centre.x, one.z - centre.z)),
                    commands.headingTo(one, centre),
                    latest.blocks.length,
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
                commands.HOME_CLEARANCE + radius
            );
            if (found === "failed") throw new PlaceNotFound();
            return found;
        },
        giveUpSite: (point) => retryPlace(installedAppId, loop, server, point),
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
    constructor() {
        super("No dry ground was found for it near the players");
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
                // The final blow always places, whatever it was dealt with.
                const killer =
                    [...scores.keys()].find(
                        (name) => name.toLowerCase() === run.decidedBy!.toLowerCase()
                    ) ?? run.decidedBy;
                scores.set(killer, Math.max(scores.get(killer) ?? 0, minimum));
                if (!took.some((name) => name.toLowerCase() === killer.toLowerCase()))
                    took.push(killer);
            }
            placed = plan.podium(scores, disqualified, minimum);
            // Taking part is reaching the minimum too - one zombie is not taking part
            // in a hunt. A blood moon's is surviving it with a kill, and a horde
            // defence's holding the point, which are their own bars.
            const counted =
                preset.kind === "blood-moon" ||
                preset.kind === "waves" ||
                // A boss is fought together: any damage to it is taking part.
                preset.kind === "world-boss"
                    ? took
                    : took.filter((name) => (scores.get(name) ?? 0) >= minimum);
            const owed = plan.prizes(placed, counted, preset.rewards, disqualified);
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
            lines.push(commands.say(messages.resultsHeader(preset.name, language)));
            if (catalog.playsInArena(preset))
                lines.push(...arenaService.resultLines(run, language));
            if (preset.kind === "world-boss" && !run.decidedBy) {
                lines.push(
                    commands.say(
                        messages.bossEscaped(
                            messages.bossName(
                                (preset.options as catalog.EventOptions<"world-boss">).boss,
                                language
                            ),
                            language
                        )
                    )
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
        delivered
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
        delivered: []
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
    const unit = catalog.KIND_INFO[preset.kind].unit;
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
        const mix = (preset.options as catalog.EventOptions<"waves">).mix;
        await server.sayAll(waves.wavesTick(run.place, mix, run.roundEndsAt !== null));
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

/** Whether this server's attribute ids have lost their `generic.`: the one tried first. */
async function modernity(server: ServerContainer): Promise<{ ids: boolean }> {
    return { ids: await serverAtLeast(server, [1, 21, 2]) };
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
    if (seen === null) return false;
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
                waiting: `Waiting: ${busy}`
            }));
            continue;
        }
        await updateEventState(installedAppId, (current) => ({
            ...current,
            scheduleRuns: { ...current.scheduleRuns, [entry.id]: now }
        }));
        if (busy) {
            await skip(installedAppId, preset, "scheduled", `Skipped: ${busy}`);
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
                `Skipped: ${error instanceof Error ? error.message : "it could not start"}`
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
        now,
        random: Math.random
    });
    await updateEventState(installedAppId, (current) =>
        current.nextRandomAt === decision.nextRandomAt && current.waiting === decision.waiting
            ? current
            : { ...current, nextRandomAt: decision.nextRandomAt, waiting: decision.waiting }
    );
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
            waiting: error instanceof Error ? error.message : "The drawn event could not start"
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
            delivered: []
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
            arrived.push({ runId: one.id.slice(0, -(one.player.length + 1)), prize: handed.delivered });
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
