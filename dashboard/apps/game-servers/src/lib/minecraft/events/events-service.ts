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
import * as commands from "./commands";
import * as messages from "./messages";
import * as trivia from "./trivia-bank";
import { host } from "@polaris/app-host";
import { readSchedule } from "../schedule";
import { holdSidebar, releaseSidebar } from "../live-display-service";
import { containerFileSize, readContainerRange } from "../../container-files";
import {
    editionOf,
    openServerContainer,
    withServerContainer,
    type ServerContainer
} from "../service";

const { readInstallConfig } = host.appsInstallConfig;

const TICK_MS = 2_000;
/** How often the loop looks at who is where, to know who took part. */
const SAMPLE_EVERY_MS = 15_000;
/** How often the participants are written down, so a restart knows them. */
const SAVE_EVERY_MS = 60_000;
/** How long a server that stopped answering is waited for past an event's end. */
const GIVE_UP_AFTER_MS = 2 * 60_000;
/** How many places are tried before an event that needs one gives up. */
const PLACE_TRIES = 6;
const WRITE_TRIES = 5;
const LOG_FILE = "/data/logs/latest.log";

interface Loop {
    readonly ownerId: string;
    readonly timer: ReturnType<typeof setInterval>;
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
    /** How this server writes a name into an entity, and its attribute ids. */
    modern: { text: boolean; ids: boolean } | null;
    /** Trivia: how long the log was when the round was asked. */
    logFrom: number | null;
    /** The countdown marks already sounded, in seconds before the start. */
    sounded: Set<number>;
    announced: boolean;
    language: catalog.Language;
    countdown: number;
}

const loops = new Map<string, Loop>();
/** What each server's players were last seen doing, to tell playing from idle. */
const activity = new Map<string, Map<string, plan.Seen>>();

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
        standings = await currentStandings(row.ownerId, installedAppId, run).catch(() => []);
    }
    const seen = activity.get(installedAppId);
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

async function currentStandings(
    ownerId: string,
    installedAppId: string,
    run: stored.EventRun
): Promise<{ name: string; score: number }[]> {
    if (run.preset.kind === "trivia") {
        return Object.entries(run.points)
            .map(([name, score]) => ({ name, score }))
            .sort((left, right) => right.score - left.score);
    }
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
    // The minimum is for events that start on their own. An operator who
    // presses Run has looked at who is on and decided.
    const active = plan.activePlayers(seen, config.settings.afkMinutes, Date.now()).length;
    const needed = catalog.activeNeeded(preset, config.settings);
    if (input.trigger !== "manual" && active < needed) {
        throw new Error(`Only ${active} of the ${seen.size} players on are active; this event waits for ${needed}`);
    }

    const now = Date.now();
    const countdown = config.settings.countdownSeconds * 1000;
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
        gamerules: {}
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

/** Stop waiting to hand somebody a prize. */
export async function forgetPending(installedAppId: string, pendingId: string): Promise<void> {
    await updateEventState(installedAppId, (state) => ({
        ...state,
        pending: state.pending.filter((one) => one.id !== pendingId)
    }));
}

// ------------------------------------------------------------------ the loop

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
        timer: setInterval(() => {
            if (loop.busy) return;
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
        }, TICK_MS),
        busy: false,
        run,
        link: null,
        ticks: 0,
        lastSample: 0,
        lastSave: Date.now(),
        finishing: false,
        bossAt: null,
        modern: null,
        logFrom: null,
        sounded: new Set(),
        // Resumed after a restart: the countdown was already said.
        announced: run.phase === "running",
        language: settings.language,
        countdown: settings.countdownSeconds
    };
    loop.timer.unref?.();
    loops.set(installedAppId, loop);
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
    if (!loop.link) loop.link = await openServerContainer(loop.ownerId, installedAppId);
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
    if (run.cancelled) return finish(installedAppId, loop, server, "cancelled", "Called off");

    if (run.phase === "countdown") return countdown(installedAppId, loop, server, now);

    if (now - loop.lastSample >= SAMPLE_EVERY_MS) {
        loop.lastSample = now;
        const seen = await look(installedAppId, server);
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
        if (error instanceof PlaceNotFound)
            return finish(installedAppId, loop, server, "failed", error.message);
        throw error;
    }
    if (done) return finish(installedAppId, loop, server, "finished", done);
    if (now >= loop.run.endsAt)
        return finish(installedAppId, loop, server, "finished", "Ran its full time");
    if (now - loop.lastSave >= SAVE_EVERY_MS) await persist(installedAppId, loop);
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
            commands.sound(commands.SOUNDS.tick)
        ]);
    }
    if (now < loop.run.startsAt) {
        const lines = commands.barUpdate(
            messages.startsInBar(title, left, language),
            left,
            Math.max(1, loop.countdown)
        );
        const mark = Math.ceil(left);
        if ([30, 10, 5, 4, 3, 2, 1].includes(mark) && !loop.sounded.has(mark)) {
            loop.sounded.add(mark);
            lines.push(commands.sound(commands.SOUNDS.tick));
            if (mark <= 5) lines.push(`title @a actionbar ${commands.text(`&e${mark}`)}`);
        }
        await server.sayAll(lines);
        return;
    }
    await begin(installedAppId, loop, server, now);
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
        commands.say(messages.tag(language) + messages.lasts(catalog.runMinutes(preset), language)),
        commands.sound(preset.kind === "blood-moon" ? commands.SOUNDS.horn : commands.SOUNDS.start)
    ];
    if (preset.kind === "world-boss") {
        lines.push(
            ...commands.bossScoreboard((preset.options as catalog.EventOptions<"world-boss">).boss)
        );
    }
    if (preset.kind === "blood-moon") {
        // Held still until dawn: the clock, or the night runs out before the
        // event does or is slept through; the weather, or the storm clears.
        // What each was is kept, and put back when it ends.
        const before: Record<string, string> = {};
        for (const rule of commands.FROZEN_RULES) {
            const value = commands.readRuleValue(await server.say([commands.readRule(rule)]));
            if (value === null) continue;
            before[rule] = value;
            lines.push(commands.setRule(rule, "false"));
        }
        loop.run = { ...loop.run, gamerules: { ...before, ...loop.run.gamerules } };
        lines.push(...commands.nightfall(seconds));
    }
    if (preset.kind === "happy-hour") {
        lines.push(
            ...commands.happyEffects(preset.options as catalog.EventOptions<"happy-hour">, seconds)
        );
    }
    await server.sayAll(lines);
    loop.run = { ...loop.run, phase: "running", startsAt: now };
    await persist(installedAppId, loop);
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
    const total = (loop.run.endsAt - loop.run.startsAt) / 1000;
    const lines: string[] = [];

    if (preset.kind !== "world-boss") {
        lines.push(...commands.barUpdate(messages.barName(preset.name, left), left, total));
    }
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
        default:
            break;
    }
    if (lines.length > 0) await server.sayAll(lines);
    return decided;
}

// ------------------------------------------------------------------ finding a place

/**
 * Somewhere for the event to happen, found over a few ticks: a point chosen,
 * its chunk loaded, a marker dropped onto the surface there. A point in water
 * is given up and another tried. Answers the point once it is found.
 */
async function findPlace(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    place: catalog.EventPlace,
    distance: number
): Promise<stored.Point | "failed" | null> {
    if (!loop.run.target) {
        const centre = await centreFor(server, place);
        if (!centre) return "failed";
        const point =
            place.mode === "fixed" && loop.run.placeTries === 0
                ? centre
                : commands.pointAway(centre, distance, Math.random);
        // Written down before the chunk is loaded, so whatever ends the event
        // knows which one to let go of.
        loop.run = { ...loop.run, target: { x: point.x, z: point.z } };
        await persist(installedAppId, loop);
        await server.sayAll([commands.forceload(point.x, point.z)]);
        return null;
    }
    const { x, z } = loop.run.target;
    let output = "";
    for (const line of commands.markSurface(x, z)) output = await server.say([line]);
    if (commands.spreadWorked(output)) {
        const point = commands.readPoint(await server.say([commands.READ_MARK]));
        if (point) {
            loop.run = { ...loop.run, place: point };
            await persist(installedAppId, loop);
            return point;
        }
    }
    await server.sayAll([commands.CLEAR_MARK, commands.forceloadRemove(x, z)]);
    loop.run = { ...loop.run, target: null, placeTries: loop.run.placeTries + 1 };
    await persist(installedAppId, loop);
    return loop.run.placeTries >= PLACE_TRIES ? "failed" : null;
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
            options.distance
        );
        if (found === "failed") throw new PlaceNotFound();
        if (!found) return null;
        await server.sayAll([commands.placeChest(found, options.loot), commands.CLEAR_MARK]);
        // Placed, and unopened: a protected area or a plugin that refused the
        // block would otherwise read as a chest somebody already opened.
        if (commands.readTest(await server.say([commands.chestUnopened(found)])) !== "passed") {
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
    const answer = commands.readTest(await server.say([commands.chestUnopened(place)]));
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
        const found = await findPlace(installedAppId, loop, server, options.place, 24);
        if (found === "failed") throw new PlaceNotFound();
        if (!found) return null;
        const modern = loop.modern ?? (loop.modern = await modernity(server));
        await server.sayAll(commands.summonBoss(options.boss));
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
            commands.bossNameCommand(name, modern.text),
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
    loop.run = { ...loop.run, decidedBy: by };
    lines.push(commands.say(messages.tag(language) + messages.bossFell(name, by, language)));
    return `Defeated; the final blow by ${by}`;
}

async function kingOfTheHill(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    lines: string[]
): Promise<string | null> {
    const options = loop.run.preset.options as catalog.EventOptions<"king-of-the-hill">;
    if (!loop.run.place) {
        const found = await findPlace(installedAppId, loop, server, options.place, 32);
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
    lines.push(...commands.hillTick(loop.run.place, options.radius, TICK_MS / 1000));
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

/** The round being played, what it asks and what counts as right. */
function roundOf(
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
        lines.push(
            commands.say(
                messages.tag(language) +
                    (asked.kind === "scramble"
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
            commands.say(
                messages.tag(language) +
                    messages.roundWon(winner, asked.accepted[0] ?? "", language)
            ),
            commands.sound(commands.SOUNDS.win)
        );
        await persist(installedAppId, loop);
        return null;
    }
    if (now >= (loop.run.roundEndsAt ?? now)) {
        loop.run = { ...loop.run, roundEndsAt: null, closedAt: now };
        lines.push(
            commands.say(
                messages.tag(language) + messages.roundMissed(asked.accepted[0] ?? "", language)
            )
        );
        await persist(installedAppId, loop);
    }
    return null;
}

/** A chat line in the server log: `[12:00:01] [Server thread/INFO]: <Alice> hello`,
 *  NeoForge's extra bracket and the "Not Secure" mark allowed for. */
const CHAT_LINE = /\]: (?:\[Not Secure\] )?<([A-Za-z0-9_]{1,16})> (.+)$/gm;

/** Whoever said a right answer first in a stretch of log. */
export function firstRight(log: string, accepted: readonly string[]): string | null {
    for (const match of log.matchAll(CHAT_LINE)) {
        if (trivia.answers(match[2] as string, accepted)) return match[1] as string;
    }
    return null;
}

class PlaceNotFound extends Error {
    constructor() {
        super("No dry ground was found for it near the players");
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
    const lines: string[] = [];

    try {
        if (server && outcome === "finished" && run.phase === "running" && info.competitive) {
            disqualified = await disqualifiedSince(installedAppId, run.startsAt);
            const { scores, took } = await results(server, run);
            const minimum = catalog.minScoreOf(preset);
            placed = plan.podium(scores, disqualified, minimum);
            // Taking part is reaching the minimum too - one zombie is not taking part
            // in a hunt. A blood moon's is surviving it, which is its own bar.
            const counted =
                preset.kind === "blood-moon" ? took : took.filter((name) => (scores.get(name) ?? 0) >= minimum);
            const owed = plan.prizes(placed, counted, preset.rewards, disqualified);
            const online = new Set(
                commands
                    .readWhere(await server.say([commands.WHERE]))
                    .map((one) => one.name.toLowerCase())
            );
            for (const { name, reward } of owed) {
                if (!catalog.PLAYER_NAME.test(name)) continue;
                const left = online.has(name.toLowerCase())
                    ? await give(server, name, reward)
                    : reward;
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
            }
            if (placed.length === 0) lines.push(commands.say(messages.nobodyScored(language)));
            for (const one of placed) {
                lines.push(
                    commands.say(
                        messages.podiumLine(
                            one.place,
                            one.name,
                            scoreText(preset, one.score),
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
        } else if (server && (outcome === "cancelled" || outcome === "failed")) {
            lines.push(
                commands.say(messages.tag(language) + messages.cancelledLine(preset.name, language))
            );
        }
        if (server) {
            if (preset.kind === "blood-moon" && outcome === "finished") {
                const survivors = await survivorsOf(server, run);
                lines.unshift(
                    commands.say(messages.tag(language) + messages.dawn(survivors.length, language))
                );
            }
            await server.sayAll([...lines, ...commands.cleanup(preset, run.place, run.target, run.gamerules)]);
        } else {
            // The server was not answering: clean up when it is back, so a
            // chest, a boss or a loaded chunk is not left in the world for good.
            await cleanUpLater(loop.ownerId, installedAppId, run);
        }
    } catch (error) {
        console.warn("polaris: finishing an event failed", installedAppId, String(error));
        if (server)
            await server
                .sayAll(commands.cleanup(preset, run.place, run.target, run.gamerules))
                .catch(() => undefined);
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
        disqualified: run.participants.filter((name) => disqualified.has(name.toLowerCase()))
    };
    await updateEventState(installedAppId, (state) => ({
        ...stored.withHistory(
            { ...state, run: state.run?.id === run.id ? null : state.run },
            entry
        ),
        lastKind: preset.kind,
        pending: stored.livePending([...state.pending, ...pending], Date.now())
    })).catch((error: unknown) =>
        console.warn("polaris: recording an event failed", installedAppId, String(error))
    );
    if (loops.get(installedAppId) === loop) loops.delete(installedAppId);
}

async function cleanUpLater(
    ownerId: string,
    installedAppId: string,
    run: stored.EventRun
): Promise<void> {
    await withServerContainer(ownerId, installedAppId, async (later) => {
        if (later.running) await later.sayAll(commands.cleanup(run.preset, run.place, run.target, run.gamerules));
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
    releaseSidebar(ownerId, installedAppId);
    const now = Date.now();
    const entry: stored.EventHistoryEntry = {
        id: run.id,
        presetId: run.preset.id,
        kind: run.preset.kind,
        name: run.preset.name,
        trigger: run.trigger,
        outcome: "failed",
        note: "Stopped while its results were handed out",
        startedAt: run.startsAt,
        endedAt: now,
        participants: run.participants.length,
        podium: [],
        disqualified: []
    };
    await updateEventState(installedAppId, (state) =>
        state.run?.id === run.id
            ? { ...stored.withHistory({ ...state, run: null }, entry), lastKind: run.preset.kind }
            : state
    );
}

/** A score the way the podium says it: `12 points`, `3:20` for time on the hill. */
function scoreText(preset: catalog.EventPreset, score: number): string {
    if (preset.kind === "supply-drop") return "";
    if (preset.kind === "king-of-the-hill") return messages.clock(score);
    const unit = catalog.KIND_INFO[preset.kind].unit;
    return unit ? `${score} ${unit}` : String(score);
}

/**
 * The final scores, and everybody who took part in the event's own sense:
 * scored at all - or, on a blood moon, lived to see the dawn.
 */
async function results(
    server: ServerContainer,
    run: stored.EventRun
): Promise<{ scores: Map<string, number>; took: string[] }> {
    const { preset } = run;
    if (preset.kind === "trivia") {
        const scores = new Map(Object.entries(run.points));
        return { scores, took: [...scores.keys()] };
    }
    if (preset.kind === "supply-drop" || (preset.kind === "explorer" && isRace(preset))) {
        const scores = new Map<string, number>(run.decidedBy ? [[run.decidedBy, 1]] : []);
        return { scores, took: [] };
    }
    if (preset.kind === "world-boss" && !run.decidedBy) return { scores: new Map(), took: [] };
    // One last count first, so the final seconds are in it.
    await server.sayAll(commands.scoreTick(preset));
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
    if (preset.kind === "blood-moon") {
        const alive = new Set((await survivorsOf(server, run)).map((name) => name.toLowerCase()));
        for (const name of [...scores.keys()])
            if (!alive.has(name.toLowerCase())) scores.delete(name);
        return {
            scores,
            took: [...alive].map(
                (key) => run.participants.find((name) => name.toLowerCase() === key) ?? key
            )
        };
    }
    return {
        scores,
        took: [...scores.entries()].filter(([, score]) => score > 0).map(([name]) => name)
    };
}

/** Everybody on at dawn who did not die during the night. */
async function survivorsOf(server: ServerContainer, run: stored.EventRun): Promise<string[]> {
    const on = commands.readWhere(await server.say([commands.WHERE])).map((one) => one.name);
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
 * Hand one player their prize, a line at a time. Answers what of it did not
 * arrive, to be kept for later - never what did, which would be given twice -
 * or null when all of it did.
 */
async function give(
    server: ServerContainer,
    name: string,
    reward: catalog.Reward
): Promise<catalog.Reward | null> {
    const items: catalog.RewardItem[] = [];
    for (const item of reward.items) {
        for (const line of commands.rewardCommands(name, { items: [item], levels: 0 })) {
            if (!commands.gaveIt(await server.say([line]))) items.push(item);
        }
    }
    let levels = 0;
    for (const line of commands.rewardCommands(name, { items: [], levels: reward.levels })) {
        if (!commands.gaveIt(await server.say([line]))) levels = reward.levels;
    }
    return items.length === 0 && levels === 0 ? null : { items, levels };
}

/** How this server's version writes names into entities, and its attribute ids. */
async function modernity(server: ServerContainer): Promise<{ text: boolean; ids: boolean }> {
    const result = await server
        .run(["sh", "-c", `grep -m1 -o 'Starting minecraft server version [^ ]*' ${LOG_FILE}`])
        .catch(() => null);
    const version = /version (\S+)/.exec(result?.output ?? "")?.[1] ?? null;
    return { text: atLeast(version, [1, 21, 5]), ids: atLeast(version, [1, 21, 2]) };
}

/** Whether a version is at least another. A snapshot or an unreadable one is
 *  taken as recent, which is what a server of unknown version most likely is. */
export function atLeast(version: string | null, wanted: readonly number[]): boolean {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version ?? "");
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
    if (loop?.link?.server.running) return look(installedAppId, loop.link.server);
    return withServerContainer(ownerId, installedAppId, async (server) =>
        server.running ? look(installedAppId, server) : null
    );
}

async function look(
    installedAppId: string,
    server: ServerContainer
): Promise<Map<string, plan.Seen>> {
    const positions = commands.readWhere(await server.say([commands.WHERE]));
    const facing = commands.readFacing(await server.say([commands.FACING]));
    const seen = plan.observe(
        activity.get(installedAppId) ?? new Map(),
        positions,
        facing,
        Date.now()
    );
    activity.set(installedAppId, seen);
    return seen;
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

    // A time on the schedule first: somebody chose it.
    const due = plan.schedulesDue(settings.settings, settings.schedules, state.scheduleRuns, now);
    for (const entry of due) {
        await updateEventState(installedAppId, (current) => ({
            ...current,
            scheduleRuns: { ...current.scheduleRuns, [entry.id]: now }
        }));
        const preset = settings.presets.find((one) => one.id === entry.presetId);
        if (!preset) continue;
        const needed = catalog.activeNeeded(preset, settings.settings);
        if (active < needed) {
            await skip(installedAppId, preset, "scheduled", `Skipped: ${active} active of the ${needed} it waits for`);
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
            disqualified: []
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
    const language = settingsOf(row.config).settings.language;
    await withServerContainer(ownerId, installedAppId, async (server) => {
        if (!server.running) return;
        for (const one of owed) {
            if (!catalog.PLAYER_NAME.test(one.player)) continue;
            const rest = await give(server, one.player, one.reward);
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
    if (left.size === 0) return;
    await updateEventState(installedAppId, (current) => ({
        ...current,
        pending: current.pending.flatMap((one) => {
            if (!left.has(one.id)) return [one];
            const rest = left.get(one.id);
            return rest ? [{ ...one, reward: rest }] : [];
        })
    }));
}

/** For a test: what the loops hold. */
export function runningEvents(): string[] {
    return [...loops.keys()];
}
