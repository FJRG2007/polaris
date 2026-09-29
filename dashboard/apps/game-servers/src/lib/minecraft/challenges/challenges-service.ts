/**
 * Running a Minecraft server's challenges.
 *
 * A loop in this process per server, started by the minute sweep
 * (`sweepChallenges`) and kept for as long as challenges are on and the server
 * answers:
 * - every few seconds it reads who pressed a menu button (`/trigger pc_menu`)
 *   and answers them in the chat;
 * - every twenty seconds it reads each online player's scores in one command
 *   (`scoreboard players list <name>`), credits what they earned - not what
 *   rose while they stood still, not past a template's ceiling - and hands out
 *   what they finished;
 * - when a day, a week, a month or a community goal comes round it reads
 *   everybody who took part, online or not, pays what they finished, and draws
 *   the next pool.
 *
 * Everything the game is told goes through `say`/`sayAll`, which wait their
 * turn on the server's RCON (`rcon-turn.ts`); everything Polaris decides waits
 * its turn per server here (`inTurn`), so the loop and the sweep never work on
 * the same player at once.
 *
 * The operator's hard rule, kept by construction: challenges only ever read
 * statistics, count what players hold with `clear ... 0`, test advancements,
 * show text, and give. Nothing here breaks, places or removes a block or an
 * entity, or takes an item or a level from anybody.
 */

import { z } from "zod";
import * as draw from "./draw";
import * as play from "./play";
import * as stored from "./state";
import { readXray } from "../xray";
import * as period from "./period";
import * as season from "./season";
import { prisma } from "@polaris/db";
import * as catalog from "./catalog";
import * as progress from "./progress";
import * as messages from "./messages";
import * as commands from "./commands";
import * as playing from "../activity";
import { host } from "@polaris/app-host";
import { readSchedule } from "../schedule";
import { parseProperties } from "../parse";
import type * as plan from "../events/plan";
import * as settingsModule from "./settings";
import * as replies from "../events/replies";
import { readEventState } from "../events/state";
import { readEventsConfig } from "../events/catalog";
import { containerFileSize, readContainerFile, readContainerRange } from "../../container-files";
import { editionOf, openServerContainer, withServerContainer, type ServerContainer } from "../service";

const { readInstallConfig } = host.appsInstallConfig;

/**
 * A refusal the screen may show: its message is a key of the app's
 * `challenges` catalog (`errors.*`), translated by the action for its reader.
 * Anything else thrown here is logged and replaced with a generic sentence.
 */
export class ChallengeRefusal extends Error {
    constructor(readonly key: string) {
        super(key);
        this.name = "ChallengeRefusal";
    }
}

/** How often button presses are read. */
const TICK_MS = 3_000;
/** How often every online player's progress is read. */
const READ_MS = 20_000;
/** How often what takes a command per item or advancement is looked at. */
const SLOW_MS = 60_000;
/** How often advancements files are read. */
const FILE_MS = 5 * 60_000;
/** The least time between two action-bar lines to one player. */
const TELL_EVERY_MS = 10_000;
/** How long after a newcomer's first join a hello counts. */
const WELCOME_MS = 5 * 60_000;
const WRITE_TRIES = 5;
const LOG_FILE = "/data/logs/latest.log";

// ------------------------------------------------------------------ one at a time, per server

const turns = new Map<string, Promise<unknown>>();

/** Work on one server's challenges after whatever is already working on them. */
export function inTurn<T>(installedAppId: string, work: () => Promise<T>): Promise<T> {
    const before = turns.get(installedAppId) ?? Promise.resolve();
    const turn = before.catch(() => undefined).then(work);
    const settled = turn.catch(() => undefined);
    turns.set(installedAppId, settled);
    void settled.then(() => {
        if (turns.get(installedAppId) === settled) turns.delete(installedAppId);
    });
    return turn;
}

// ------------------------------------------------------------------ storage

interface Row {
    readonly ownerId: string;
    readonly catalogId: string;
    readonly config: Record<string, unknown>;
}

async function readRow(installedAppId: string): Promise<Row | null> {
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { ownerId: true, catalogId: true, status: true, config: true }
    });
    if (!row || row.status === "removed" || !row.catalogId.startsWith("minecraft")) return null;
    return { ownerId: row.ownerId, catalogId: row.catalogId, config: readInstallConfig(row.config) };
}

/** The settings, with the events' time zone and language as the defaults. */
export function settingsOf(config: Record<string, unknown>): settingsModule.ChallengeSettings {
    const timezone = readSchedule(config).timezone;
    const events = readEventsConfig(config, timezone).settings;
    return settingsModule.readSettings(config, { timezone: events.timezone, language: events.language });
}

function clockOf(settings: settingsModule.ChallengeSettings): period.Clock {
    return { timezone: settings.timezone, resetAt: settings.resetAt, weekDay: settings.weekDay };
}

/** Change the server's state from what is stored now, never from a stale copy. */
export async function updateState(
    installedAppId: string,
    change: (state: stored.ServerState) => stored.ServerState
): Promise<stored.ServerState | null> {
    for (let attempt = 0; attempt < WRITE_TRIES; attempt += 1) {
        const row = await prisma.installedApp.findUnique({
            where: { id: installedAppId },
            select: { config: true, status: true }
        });
        if (!row || row.status === "removed") return null;
        const config = readInstallConfig(row.config);
        const next = change(stored.readServerState(config));
        const written = await prisma.installedApp.updateMany({
            where: { id: installedAppId, config: row.config },
            data: { config: JSON.stringify({ ...config, [stored.STATE_KEY]: next }) }
        });
        if (written.count > 0) return next;
    }
    throw new ChallengeRefusal("errors.busy");
}

/** Save what the screen set up. Checked again here: this is the one that decides. */
export async function saveSettings(installedAppId: string, input: unknown): Promise<settingsModule.ChallengeSettings> {
    const parsed = settingsModule.settingsSchema.safeParse(input);
    if (!parsed.success) throw new ChallengeRefusal(parsed.error.issues[0]?.message ?? "errors.checkSettings");
    for (let attempt = 0; attempt < WRITE_TRIES; attempt += 1) {
        const row = await prisma.installedApp.findUnique({
            where: { id: installedAppId },
            select: { config: true, status: true }
        });
        if (!row || row.status === "removed") throw new ChallengeRefusal("errors.notHere");
        const config = readInstallConfig(row.config);
        const written = await prisma.installedApp.updateMany({
            where: { id: installedAppId, config: row.config },
            data: { config: JSON.stringify({ ...config, [settingsModule.CHALLENGES_KEY]: parsed.data }) }
        });
        if (written.count > 0) {
            if (parsed.data.enabled)
                await updateState(installedAppId, (state) => ({ ...state, since: state.since ?? Date.now() }));
            return parsed.data;
        }
    }
    throw new ChallengeRefusal("errors.busy");
}

interface Stored {
    readonly record: stored.PlayerRecord;
    /** Whether it was just made, never stored before. */
    readonly fresh: boolean;
}

async function loadPlayers(installedAppId: string, names: readonly string[] | null, now: number): Promise<Map<string, Stored>> {
    const rows = await prisma.minecraftChallengePlayer.findMany({
        where: names === null ? { installedAppId } : { installedAppId, player: { in: names.map((name) => name.toLowerCase()) } },
        select: { player: true, playerName: true, data: true }
    });
    const found = new Map<string, Stored>();
    for (const row of rows) found.set(row.player, { record: stored.readPlayer(row.data, row.playerName, now), fresh: false });
    for (const name of names ?? []) {
        if (!found.has(name.toLowerCase())) found.set(name.toLowerCase(), { record: stored.newPlayer(name, now), fresh: true });
    }
    return found;
}

async function savePlayer(installedAppId: string, record: stored.PlayerRecord): Promise<void> {
    const player = record.name.toLowerCase();
    const data = JSON.stringify(record);
    await prisma.minecraftChallengePlayer.upsert({
        where: { installedAppId_player: { installedAppId, player } },
        create: { installedAppId, player, playerName: record.name, data },
        update: { playerName: record.name, data }
    });
}

interface Holder {
    readonly scope: string;
    readonly holder: string;
}

function holderOf(
    settings: settingsModule.ChallengeSettings,
    ownerId: string,
    installedAppId: string,
    name: string,
    links: ReadonlyMap<string, string>
): Holder {
    const user = links.get(name.toLowerCase());
    if (settings.shared.enabled && settings.shared.group && user) {
        return { scope: `group:${ownerId}:${settings.shared.group.toLowerCase()}`, holder: `user:${user}` };
    }
    return { scope: `server:${installedAppId}`, holder: `player:${name.toLowerCase()}` };
}

async function loadLedger(holder: Holder, seasonKey: string): Promise<stored.Ledger> {
    const row = await prisma.minecraftChallengeLedger.findUnique({
        where: { scope_holder: { scope: holder.scope, holder: holder.holder } },
        select: { data: true }
    });
    return stored.readLedger(row?.data ?? null, seasonKey);
}

async function saveLedger(holder: Holder, ledger: stored.Ledger): Promise<void> {
    const data = JSON.stringify(ledger);
    await prisma.minecraftChallengeLedger.upsert({
        where: { scope_holder: { scope: holder.scope, holder: holder.holder } },
        create: { scope: holder.scope, holder: holder.holder, data },
        update: { data }
    });
}

/** Players linked to a Polaris account, by lowercased name. */
async function linksOf(installedAppId: string): Promise<Map<string, string>> {
    const rows = await prisma.gamePlayerLink
        .findMany({ where: { installedAppId }, select: { player: true, userId: true } })
        .catch(() => []);
    return new Map(rows.map((row) => [row.player.toLowerCase(), row.userId]));
}

/** Everybody's ledger in a scope this season, for the median and the champions. */
async function ledgersIn(scope: string, seasonKey: string): Promise<{ holder: string; ledger: stored.Ledger }[]> {
    const rows = await prisma.minecraftChallengeLedger
        .findMany({ where: { scope }, select: { holder: true, data: true } })
        .catch(() => []);
    return rows
        .map((row) => ({ holder: row.holder, ledger: stored.readLedger(row.data, seasonKey) }))
        .filter((one) => one.ledger.points > 0);
}

// ------------------------------------------------------------------ the server's own facts

/** The version the server said it started as, out of its log; null when unread. */
async function versionOf(server: ServerContainer): Promise<string | null> {
    const result = await server
        .run(["sh", "-c", `grep -m1 -o 'Starting minecraft server version [^ ]*' ${LOG_FILE}`])
        .catch(() => null);
    return /version (\S+)/.exec(result?.output ?? "")?.[1] ?? null;
}

async function levelOf(server: ServerContainer): Promise<string> {
    const text = await readContainerFile(server, "/data/server.properties").catch(() => null);
    const name = text ? parseProperties(text)["level-name"] : undefined;
    return name && /^[A-Za-z0-9_. -]{1,64}$/.test(name) ? name : "world";
}

/** Names to uuids from the server's own cache of who has joined. */
async function uuidsOf(server: ServerContainer): Promise<Map<string, string>> {
    const text = await readContainerFile(server, "/data/usercache.json").catch(() => null);
    const found = new Map<string, string>();
    try {
        for (const entry of JSON.parse(text ?? "[]") as { name?: string; uuid?: string }[]) {
            if (typeof entry.name === "string" && typeof entry.uuid === "string" && /^[0-9a-f-]{36}$/i.test(entry.uuid))
                found.set(entry.name.toLowerCase(), entry.uuid);
        }
    } catch {
        // No cache yet.
    }
    return found;
}

// ------------------------------------------------------------------ the loop

interface Loop {
    readonly ownerId: string;
    readonly timer: ReturnType<typeof setInterval>;
    busy: boolean;
    link: { server: ServerContainer; close: () => Promise<void> } | null;
    lastRead: number;
    lastSlow: number;
    lastFile: number;
    version: string | null | undefined;
    level: string | null;
    uuids: Map<string, string> | null;
    /** Who was on at the last read, by lowercased name. */
    online: Set<string>;
    /** Players on for the first time ever, and when they joined. */
    newcomers: { name: string; at: number; greeters: string[] }[];
    logFrom: number | null;
    /** Tracked bars shown, by player, to take down when they change. */
    bars: Set<string>;
}

const loops = new Map<string, Loop>();

function ensureLoop(ownerId: string, installedAppId: string): void {
    if (loops.has(installedAppId)) return;
    const loop: Loop = {
        ownerId,
        timer: setInterval(() => void tick(installedAppId), TICK_MS),
        busy: false,
        link: null,
        lastRead: 0,
        lastSlow: 0,
        lastFile: 0,
        version: undefined,
        level: null,
        uuids: null,
        online: new Set(),
        newcomers: [],
        logFrom: null,
        bars: new Set()
    };
    loops.set(installedAppId, loop);
}

async function stopLoop(installedAppId: string): Promise<void> {
    const loop = loops.get(installedAppId);
    if (!loop) return;
    clearInterval(loop.timer);
    loops.delete(installedAppId);
    await loop.link?.close().catch(() => undefined);
}

async function tick(installedAppId: string, now = Date.now()): Promise<void> {
    const loop = loops.get(installedAppId);
    if (!loop || loop.busy) return;
    loop.busy = true;
    try {
        await inTurn(installedAppId, async () => {
            if (!loop.link) loop.link = await openServerContainer(loop.ownerId, installedAppId);
            const server = loop.link.server;
            if (!server.running) {
                await stopLoop(installedAppId);
                return;
            }
            const row = await readRow(installedAppId);
            const settings = row ? settingsOf(row.config) : null;
            if (!row || !settings?.enabled) {
                await switchOff(installedAppId, server, row);
                await stopLoop(installedAppId);
                return;
            }
            await handlePresses(installedAppId, loop, server, row, settings, now);
            if (now - loop.lastRead >= READ_MS) {
                loop.lastRead = now;
                await readAll(installedAppId, loop, server, now);
            }
        });
    } catch (error) {
        // A server that stopped answering: the connection is opened again on
        // the next tick; a loop whose server is gone is let go by the sweep.
        console.warn("polaris: challenges tick failed", installedAppId, String(error));
        await loop.link?.close().catch(() => undefined);
        loop.link = null;
    } finally {
        loop.busy = false;
    }
}

/** Challenges switched off: their objectives and bars taken down. Nothing of a
 *  player's is touched; what they were owed stays owed. */
async function switchOff(installedAppId: string, server: ServerContainer, row: Row | null): Promise<void> {
    if (!row) return;
    const state = stored.readServerState(row.config);
    const names = [state.daily, state.weekly, state.card, state.community].flatMap((one) => (one ? Object.values(one.objectives) : []));
    if (names.length === 0 && !state.daily) return;
    const loop = loops.get(installedAppId);
    await server.sayAll(commands.teardown(names, [...(loop?.bars ?? [])])).catch(() => undefined);
    await updateState(installedAppId, (current) => ({
        ...current,
        daily: current.daily ? { ...current.daily, applied: false } : null,
        weekly: current.weekly ? { ...current.weekly, applied: false } : null,
        card: current.card ? { ...current.card, applied: false } : null,
        community: current.community ? { ...current.community, applied: false } : null
    }));
}

// ------------------------------------------------------------------ a look at everybody

interface Sweep {
    readonly installedAppId: string;
    readonly ownerId: string;
    readonly loop: Loop;
    readonly server: ServerContainer;
    readonly settings: settingsModule.ChallengeSettings;
    readonly config: Record<string, unknown>;
    state: stored.ServerState;
    readonly now: number;
    readonly clock: period.Clock;
    readonly season: period.Season;
    readonly links: Map<string, string>;
    readonly seen: ReadonlyMap<string, plan.Seen>;
    readonly context: play.Context;
    readonly eventOn: boolean;
    /** Who the anti-xray caught, and when, by lowercased name. */
    readonly caught: Map<string, number[]>;
}

function firstDayOf(settings: settingsModule.ChallengeSettings, state: stored.ServerState, clock: period.Clock, now: number): string {
    if (settings.season.start) return settings.season.start;
    return period.dayKey(clock, state.since ?? now);
}

async function contextFor(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    row: Row,
    settings: settingsModule.ChallengeSettings,
    now: number
): Promise<Sweep> {
    if (loop.version === undefined) loop.version = await versionOf(server);
    const state = stored.readServerState(row.config);
    const clock = clockOf(settings);
    const seasonNow = period.seasonOf(clock, now, firstDayOf(settings, state, clock, now), settings.season.weeks);
    const links = await linksOf(installedAppId);
    const scope = holderOf(settings, row.ownerId, installedAppId, "-", new Map()).scope;
    const tiers = (await ledgersIn(scope, seasonNow.key)).map((one) => season.tierOf(one.ledger.points, settings));
    const version = loop.version;
    return {
        installedAppId,
        ownerId: row.ownerId,
        loop,
        server,
        settings,
        config: row.config,
        state,
        now,
        clock,
        season: seasonNow,
        links,
        seen: new Map(),
        eventOn: readEventState(row.config).run !== null,
        caught: caughtBy(row.config),
        context: {
            settings,
            language: settings.language,
            now,
            clock,
            day: period.dayKey(clock, now),
            season: seasonNow,
            medianTier: season.medianTier(tiers),
            spelling: commands.spellingFor(version, (wanted) => catalog.atLeast(version, wanted))
        }
    };
}

/** Anti X-Ray's hits, by lowercased name. */
function caughtBy(config: Record<string, unknown>): Map<string, number[]> {
    const found = new Map<string, number[]>();
    for (const [key, evidence] of Object.entries(readXray(config).evidence)) {
        found.set(key, evidence.hits.map((hit) => hit.at));
    }
    return found;
}

async function readAll(installedAppId: string, loop: Loop, server: ServerContainer, now: number): Promise<void> {
    const row = await readRow(installedAppId);
    if (!row) return;
    const settings = settingsOf(row.config);
    if (!settings.enabled) return;
    const sweep = await contextFor(installedAppId, loop, server, row, settings, now);
    if (sweep.state.version !== (loop.version ?? null)) {
        sweep.state = (await updateState(installedAppId, (state) => ({ ...state, version: loop.version ?? null }))) ?? sweep.state;
    }
    // Who is on first: a period closing now pays them in person, not into the queue.
    const seen = await playing.lookIfDue(installedAppId, server);
    const live: Sweep = { ...sweep, seen };
    await rotate(live);
    await server.sayAll(commands.MENU_SETUP);
    const slow = now - loop.lastSlow >= SLOW_MS;
    if (slow) loop.lastSlow = now;
    const files = now - loop.lastFile >= FILE_MS;
    if (files) loop.lastFile = now;
    const names = [...seen.values()].map((one) => one.name);
    const players = await loadPlayers(installedAppId, names, now);
    for (const one of seen.values()) {
        const held = players.get(one.name.toLowerCase());
        if (!held) continue;
        await readPlayer(live, held, one, { slow, files }).catch((error: unknown) =>
            console.warn("polaris: reading a player's challenges failed", installedAppId, one.name, String(error))
        );
    }
    await welcome(live, players);
    await runGoals(live);
    loop.online = new Set(names.map((name) => name.toLowerCase()));
}

// ------------------------------------------------------------------ periods

type Layer = "daily" | "weekly" | "card";

function keyFor(layer: Layer, clock: period.Clock, now: number): { key: string; endsAt: number } {
    if (layer === "daily") return { key: period.dayKey(clock, now), endsAt: period.dayEndsAt(clock, now) };
    if (layer === "weekly") return { key: period.weekKey(clock, now), endsAt: period.weekEndsAt(clock, now) };
    return { key: period.monthKey(clock, now), endsAt: period.monthEndsAt(clock, now) };
}

function running(goals: readonly stored.GoalState[], now: number): stored.GoalState[] {
    return goals.filter((goal) => !goal.finished && goal.startedAt <= now && now < goal.endsAt);
}

/**
 * Every layer whose period came round: the one that ended read and paid for
 * everybody who took part, its objectives made again for the new draw.
 */
async function rotate(sweep: Sweep): Promise<void> {
    const { settings, clock, now, installedAppId } = sweep;
    await endSeason(sweep);
    for (const layer of ["daily", "weekly", "card"] as const) {
        const current = sweep.state[layer];
        if (!settings.layers[layer]) {
            if (current) {
                await closePeriod(sweep, layer, current);
                await sweep.server.sayAll(commands.removeObjectives(Object.values(current.objectives)));
                sweep.state = (await updateState(installedAppId, (state) => ({ ...state, [layer]: null }))) ?? sweep.state;
            }
            continue;
        }
        const { key, endsAt } = keyFor(layer, clock, now);
        if (current?.key === key && current.applied) continue;
        if (current && current.key !== key) await closePeriod(sweep, layer, current);
        const pool =
            current?.key === key
                ? current.pool
                : drawFor(sweep, layer, key);
        const next = await applyPeriod(sweep, layer, key, now, endsAt, pool, current);
        sweep.state =
            (await updateState(installedAppId, (state) => ({
                ...state,
                [layer]: next,
                recent:
                    current?.key === key
                        ? state.recent
                        : {
                              ...state.recent,
                              [layer]: [next.pool.map((entry) => entry.template), ...state.recent[layer]].slice(0, layer === "daily" ? 3 : 2)
                          }
            }))) ?? sweep.state;
    }
    await rotateCommunity(sweep);
}

/** The pool for a new period, drawn from what this server may deal. */
export function drawFor(sweep: Pick<Sweep, "settings" | "state" | "installedAppId" | "loop">, layer: Layer, key: string): stored.PoolEntry[] {
    const input: draw.DrawInput = {
        settings: sweep.settings,
        version: sweep.loop.version ?? sweep.state.version,
        recent: sweep.state.recent[layer].flat(),
        pace: sweep.state.pace,
        seed: `${sweep.installedAppId}:${key}`,
        budget: draw.BUDGET[layer],
        goalRunning: running(sweep.state.goals, Date.now()).length > 0
    };
    const pool = draw.drawPool(layer, input);
    return layer === "card" ? draw.layCard(pool) : pool;
}

/**
 * A period's objectives made on the server: the ones of the period before
 * taken down, each statistic made afresh so it counts from 0, and the
 * statistics this version does not have noted - a challenge left with nothing
 * it can count is taken out of the pool.
 */
async function applyPeriod(
    sweep: Sweep,
    layer: catalog.Layer,
    key: string,
    now: number,
    endsAt: number,
    pool: readonly stored.PoolEntry[],
    before: stored.Period | null
): Promise<stored.Period> {
    const criteria = draw.poolCriteria(pool);
    const objectives = draw.objectivesFor(layer, criteria);
    const names = new Set(Object.values(objectives));
    const stale = Object.values(before?.objectives ?? {}).filter((name) => !names.has(name));
    await sweep.server.sayAll([...commands.removeObjectives(stale), ...commands.addObjectives(objectives)]);
    const made = progress.readObjectives(await sweep.server.say([commands.LIST_OBJECTIVES]));
    const refused = Object.entries(objectives)
        .filter(([, name]) => !made.has(name))
        .map(([criterion]) => criterion);
    const kept = pool.filter((entry) => {
        const template = catalog.templateOf(entry.template);
        if (!template) return false;
        const check = catalog.checkOf(template, entry.variant);
        const counted = catalog.criteriaOf(check);
        if (counted.length === 0) return true;
        const positive = positivesOf(check);
        return positive.length === 0 || positive.some((criterion) => !refused.includes(criterion));
    });
    return {
        key,
        startedAt: before?.key === key ? before.startedAt : now,
        endsAt,
        pool: kept,
        objectives: Object.fromEntries(Object.entries(objectives).filter(([criterion]) => !refused.includes(criterion))),
        refused,
        applied: true
    };
}

/** The statistics that make a check go up. */
function positivesOf(check: catalog.Check): string[] {
    if (check.kind === "sum") return check.parts.filter((part) => part.sign > 0).map((part) => part.criterion);
    if (check.kind === "distinct") return check.groups.flatMap((group) => group.filter((part) => part.sign > 0).map((part) => part.criterion));
    if (check.kind === "survive") return check.parts.map((part) => part.criterion);
    if (check.kind === "held") return catalog.heldParts(check.items).filter((part) => part.sign > 0).map((part) => part.criterion);
    return [];
}

/**
 * A period that ended: everybody dealt it read one last time - offline players'
 * scores stay on the scoreboard until the objectives are made again - and paid
 * for what they finished; its results kept for pace.
 */
async function closePeriod(current: Sweep, layer: Layer, ended: stored.Period): Promise<void> {
    // A daily finished at the last read counts for the day it was done on.
    const sweep: Sweep = layer === "daily" ? { ...current, context: { ...current.context, day: ended.key } } : current;
    const players = await loadPlayers(sweep.installedAppId, null, sweep.now);
    const counts = new Map<string, { tier: catalog.Difficulty; dealt: number; done: number }>();
    for (const held of players.values()) {
        const layered = held.record[layer];
        if (!layered || layered.key !== ended.key) continue;
        const name = held.record.name;
        const online = sweep.seen.has(name.toLowerCase());
        let record = held.record;
        if (commands.PLAYER_NAME.test(name)) {
            const scores = progress.readList(await sweep.server.say([commands.listScores(name)]).catch(() => ""));
            const instances = layered.instances.map((instance) => creditStats(sweep, name, instance, ended, scores, true));
            record = { ...record, [layer]: { ...layered, instances } };
            record = await settleAndCarry(sweep, record, online);
        }
        for (const instance of record[layer]?.instances ?? []) {
            const tally = counts.get(instance.template) ?? { tier: instance.tier, dealt: 0, done: 0 };
            counts.set(instance.template, { ...tally, dealt: tally.dealt + 1, done: tally.done + (instance.doneAt !== null ? 1 : 0) });
        }
        if (layer === "daily") {
            const today = period.dayKey(sweep.clock, sweep.now);
            record = play.toBacklog(record, record.daily ?? layered, ended.key, today, period.dayNumber);
        }
        await savePlayer(sweep.installedAppId, record);
    }
    const outcomes: stored.Outcome[] = [...counts.entries()].map(([template, tally]) => ({
        layer,
        key: ended.key,
        template,
        tier: tally.tier,
        dealt: tally.dealt,
        done: tally.done
    }));
    current.state =
        (await updateState(sweep.installedAppId, (state) => {
            const pace = { ...state.pace };
            for (const one of outcomes) pace[one.template] = draw.nextPace(pace[one.template] ?? 1, one.dealt, one.done);
            return {
                ...state,
                pace,
                outcomes: [...outcomes, ...state.outcomes].slice(0, stored.OUTCOMES_KEPT)
            };
        })) ?? current.state;
}

/** A season that ended: who topped it named champions, told to everybody. */
async function endSeason(sweep: Sweep): Promise<void> {
    const before = sweep.state.season;
    if (before === sweep.season.key) return;
    if (before !== null && sweep.settings.layers.season) {
        const scope = holderOf(sweep.settings, sweep.ownerId, sweep.installedAppId, "-", new Map()).scope;
        const rows = await prisma.minecraftChallengeLedger.findMany({ where: { scope }, select: { holder: true, data: true } }).catch(() => []);
        const ended = rows
            .map((row) => ({ holder: row.holder, ledger: stored.readLedger(row.data, before) }))
            .filter((one) => one.ledger.season === before && one.ledger.points > 0);
        const top = Math.max(0, ...ended.map((one) => season.tierOf(one.ledger.points, sweep.settings)));
        const champions = top > 0 ? ended.filter((one) => season.tierOf(one.ledger.points, sweep.settings) === top) : [];
        const number = Number(before.split("#")[1] ?? 0);
        const names = champions.map((one) => one.holder.replace(/^(player|user):/, ""));
        for (const one of champions) {
            const title = messages.championTitle(number, sweep.settings.language);
            await saveLedger({ scope, holder: one.holder }, { ...one.ledger, titles: [...one.ledger.titles, title].slice(-10) });
        }
        const shown = await namesFor(sweep.installedAppId, names);
        await sweep.server.sayAll([`tellraw @a ${commandsText(messages.seasonEnded(number, shown, sweep.settings.language))}`]);
        sweep.state =
            (await updateState(sweep.installedAppId, (state) => ({
                ...state,
                season: sweep.season.key,
                seasons: [{ key: before, endedAt: sweep.now, champions: shown }, ...state.seasons].slice(0, 20)
            }))) ?? sweep.state;
        return;
    }
    sweep.state = (await updateState(sweep.installedAppId, (state) => ({ ...state, season: sweep.season.key }))) ?? sweep.state;
}

function commandsText(line: string): string {
    return commands.tell("@a", line).slice("tellraw @a ".length);
}

/** The game's spelling of each holder: a player's name, or a linked account's player. */
async function namesFor(installedAppId: string, holders: readonly string[]): Promise<string[]> {
    const players = await prisma.minecraftChallengePlayer
        .findMany({ where: { installedAppId }, select: { player: true, playerName: true } })
        .catch(() => []);
    const links = await linksOf(installedAppId);
    return holders.map((holder) => {
        const byName = players.find((one) => one.player === holder.toLowerCase());
        if (byName) return byName.playerName;
        const linked = [...links.entries()].find(([, user]) => user === holder)?.[0];
        return players.find((one) => one.player === linked)?.playerName ?? linked ?? holder;
    });
}

// ------------------------------------------------------------------ community goals

/** Default rewards for a goal Polaris draws itself. */
const AUTO_GOAL_REWARDS = [
    { points: 10, levels: 2, items: [] },
    { points: 15, levels: 3, items: [] },
    { points: 20, levels: 4, items: [] },
    { points: 25, levels: 5, items: [] },
    { points: 30, levels: 6, items: [{ id: "minecraft:diamond", count: 2 }] }
];

/** The goals as they should be now: the operator's copied in, a drawn one when
 *  none runs and that is wanted, and every goal's objectives made. */
async function rotateCommunity(sweep: Sweep): Promise<void> {
    const { settings, now, clock } = sweep;
    let goals = [...sweep.state.goals];
    if (settings.layers.community) {
        for (const goal of settings.community.goals) {
            if (goals.some((one) => one.id === goal.id)) continue;
            const start = period.dayNumber(goal.start);
            const today = period.dayNumber(period.dayKey(clock, now));
            // From the reset of its first day to the reset after its last.
            const todayStarted = period.dayEndsAt(clock, now) - 86_400_000;
            const startsAt = todayStarted + (start - today) * 86_400_000;
            const endsAt = todayStarted + (start + goal.days - today) * 86_400_000;
            if (endsAt <= now) continue;
            goals.push(
                stored.goalStateSchema.parse({
                    id: goal.id,
                    template: goal.template,
                    target: goal.target,
                    startedAt: startsAt,
                    endsAt,
                    minShare: goal.minShare,
                    rewards: goal.rewards
                })
            );
        }
        if (settings.community.auto && running(goals, now).length === 0) {
            const active = playing.seenOn(sweep.installedAppId);
            const count = active ? [...active.values()].length : 2;
            const drawn = draw.autoGoal(settings, sweep.loop.version ?? null, count, `${sweep.installedAppId}:${period.weekKey(clock, now)}`);
            if (drawn) {
                goals.push(
                    stored.goalStateSchema.parse({
                        id: `auto-${period.weekKey(clock, now)}`,
                        template: drawn.template,
                        variant: drawn.variant,
                        target: drawn.target,
                        startedAt: now,
                        endsAt: period.weekEndsAt(clock, now),
                        minShare: 2,
                        rewards: AUTO_GOAL_REWARDS,
                        auto: true
                    })
                );
            }
        }
    }
    // A goal the operator took out of the list stops; one that ran out is finished below.
    goals = goals.filter((goal) => goal.auto || goal.finished || settings.community.goals.some((one) => one.id === goal.id));
    const live = settings.layers.community ? running(goals, now) : [];
    const key = live.map((goal) => goal.id).sort().join(",");
    const current = sweep.state.community;
    const ended = goals.filter((goal) => !goal.finished && (goal.endsAt <= now || !live.includes(goal)) && goal.startedAt <= now);
    if (ended.length > 0 && current) {
        for (const goal of ended) await finishGoal(sweep, goal, current);
        goals = goals.map((goal) => (ended.includes(goal) ? { ...goal, finished: true } : goal));
        await sweep.server.sayAll([commands.barRemove(commands.GOAL_BAR)]);
    }
    goals = goals.filter((goal) => !goal.finished || now - goal.endsAt < 30 * 86_400_000).slice(-20);
    let community = current;
    if (!current || current.key !== key || !current.applied) {
        if (live.length === 0) {
            if (current) await sweep.server.sayAll(commands.removeObjectives(Object.values(current.objectives)));
            community = null;
        } else {
            const pool = live.map((goal) => ({ template: goal.template, variant: goal.variant, tier: "hard" as const, target: goal.target }));
            community = await applyPeriod(sweep, "community", key, now, Math.min(...live.map((goal) => goal.endsAt)), pool, current);
        }
    }
    if (JSON.stringify(goals) === JSON.stringify(sweep.state.goals) && JSON.stringify(community) === JSON.stringify(sweep.state.community))
        return;
    sweep.state = (await updateState(sweep.installedAppId, (state) => ({ ...state, goals, community }))) ?? sweep.state;
}

/** A goal that ended: everybody who took part read once more, and the tiers
 *  reached since the last look paid. */
async function finishGoal(sweep: Sweep, goal: stored.GoalState, community: stored.Period): Promise<void> {
    const players = await loadPlayers(sweep.installedAppId, null, sweep.now);
    const shares = { ...goal.shares };
    for (const held of players.values()) {
        const mine = held.record.community[goal.id];
        if (!mine) continue;
        const scores = progress.readList(await sweep.server.say([commands.listScores(held.record.name)]).catch(() => ""));
        const next = creditStats(sweep, held.record.name, mine, community, scores, true);
        shares[held.record.name.toLowerCase()] = { name: held.record.name, value: next.progress };
        await savePlayer(sweep.installedAppId, { ...held.record, community: { ...held.record.community, [goal.id]: next } });
    }
    await payGoalTiers(sweep, { ...goal, shares });
}

/** Every goal running: its boss bar, and any tier reached paid to those who earned it. */
async function runGoals(sweep: Sweep): Promise<void> {
    const live = running(sweep.state.goals, sweep.now);
    const first = live[0];
    if (!first || !sweep.settings.layers.community) return;
    const total = Object.values(first.shares).reduce((sum, one) => sum + one.value, 0);
    const title = play.titleOf({ template: first.template, variant: first.variant, target: first.target }, sweep.settings.language);
    if (sweep.eventOn) await sweep.server.sayAll(commands.barHide(commands.GOAL_BAR));
    else
        await sweep.server.sayAll(
            commands.barShow(
                commands.GOAL_BAR,
                messages.goalBar(title, play.goalTier(total, first.target), sweep.settings.language),
                total,
                first.target,
                "@a",
                "pink"
            )
        );
    for (const goal of live) await payGoalTiers(sweep, goal);
}

async function payGoalTiers(sweep: Sweep, goal: stored.GoalState): Promise<void> {
    const total = Object.values(goal.shares).reduce((sum, one) => sum + one.value, 0);
    const tier = play.goalTier(total, goal.target);
    const title = play.titleOf({ template: goal.template, variant: goal.variant, target: goal.target }, sweep.settings.language);
    const paid = { ...goal.paid };
    const lines: string[] = [];
    for (let reached = goal.tier + 1; reached <= tier; reached += 1)
        lines.push(`tellraw @a ${commandsText(messages.goalTierLine(title, reached, sweep.settings.language))}`);
    if (lines.length > 0) await sweep.server.sayAll(lines);
    for (let reached = 1; reached <= tier; reached += 1) {
        const reward = goal.rewards[reached - 1];
        if (!reward) continue;
        for (const name of play.goalEarners(goal, reached)) {
            const key = name.toLowerCase();
            if ((paid[key] ?? 0) >= reached) continue;
            paid[key] = reached;
            const online = sweep.seen.has(key);
            const effects: play.Effect[] = [];
            const holder = holderOf(sweep.settings, sweep.ownerId, sweep.installedAppId, name, sweep.links);
            if (reward.points > 0 && sweep.settings.layers.season) {
                const ledger = await loadLedger(holder, sweep.season.key);
                const earned = season.addPoints(ledger, reward.points, sweep.context.day, sweep.settings, false);
                await saveLedger(holder, earned.ledger);
                for (const one of earned.tiers) {
                    const tierReward = season.tierReward(one, sweep.settings);
                    effects.push({ kind: "tell", line: messages.tierLine(one, messages.rewardText(tierReward, sweep.settings.language), sweep.settings.language) });
                    effects.push({ kind: "pay", payout: tierReward, label: `tier ${one}` });
                }
            }
            effects.push({ kind: "tell", line: messages.goalRewardLine(messages.rewardText(reward, sweep.settings.language), sweep.settings.language) });
            effects.push({ kind: "pay", payout: reward, label: title });
            await carry(sweep, name, online, effects);
        }
    }
    // Shares move on every read while people play; they are written down at
    // most once a minute, and at once when a tier is reached or paid.
    const key = `${sweep.installedAppId}:${goal.id}`;
    const changed = tier > goal.tier || JSON.stringify(paid) !== JSON.stringify(goal.paid);
    if (!changed && sweep.now - (sharesWritten.get(key) ?? 0) < 60_000) return;
    sharesWritten.set(key, sweep.now);
    sweep.state =
        (await updateState(sweep.installedAppId, (state) => ({
            ...state,
            goals: state.goals.map((one) => (one.id === goal.id ? { ...one, shares: goal.shares, tier: Math.max(one.tier, tier), paid } : one))
        }))) ?? sweep.state;
}

/** When each goal's shares were last written, by server and goal. */
const sharesWritten = new Map<string, number>();

// ------------------------------------------------------------------ one player

function templateOrNull(instance: stored.Instance): catalog.Template | null {
    return catalog.templateOf(instance.template);
}

/** Whether a player moved or turned lately enough for what rose to count. */
function activeNow(sweep: Sweep, name: string): boolean {
    const one = sweep.seen.get(name.toLowerCase());
    if (!one || one.movedAt === null) return false;
    return sweep.now - one.movedAt <= sweep.settings.antiExploit.afkMinutes * 60_000;
}

/**
 * A challenge measured by statistics brought up to date from a player's scores.
 * Anything Polaris measures another way is left as it was, and brought up to
 * date by `creditOther`.
 */
function creditStats(
    sweep: Sweep,
    player: string,
    instance: stored.Instance,
    layer: stored.Period,
    scores: Readonly<Record<string, number>>,
    closing: boolean
): stored.Instance {
    const template = templateOrNull(instance);
    if (!template) return instance;
    const check = catalog.checkOf(template, instance.variant);
    const values = progress.valuesOf(scores, layer.objectives);
    const raw = progress.measure(check, values, instance.base);
    if (raw === null) return instance;
    return progress.credit(instance, template, raw, {
        now: sweep.now,
        active: closing || activeNow(sweep, player),
        afk: sweep.settings.antiExploit.afk,
        caps: sweep.settings.antiExploit.caps,
        gate: progress.gateRose(check, values, instance.last),
        requirement: progress.requirementMet(check, values, instance.base, instance.target),
        values
    });
}

/** The x-ray rule: a mining challenge dealt before an Anti X-Ray hit is lost. */
function xrayVoid(sweep: Sweep, name: string, instance: stored.Instance): stored.Instance {
    if (!sweep.settings.antiExploit.xray || instance.doneAt !== null || instance.voided) return instance;
    const template = templateOrNull(instance);
    if (!template || template.category !== "mining") return instance;
    const hits = sweep.caught.get(name.toLowerCase()) ?? [];
    return hits.some((at) => at >= instance.dealtAt) ? progress.voided(instance) : instance;
}

/** A look at one player. */
type ForPlayer = Sweep & { readonly player: string };

interface Pace {
    readonly slow: boolean;
    readonly files: boolean;
}

async function readPlayer(sweep: Sweep, held: Stored, seen: plan.Seen, pace: Pace): Promise<void> {
    const name = seen.name;
    if (!commands.PLAYER_NAME.test(name)) return;
    const { settings, now } = sweep;
    const current: ForPlayer = { ...sweep, player: name };
    let record: stored.PlayerRecord = {
        ...held.record,
        name,
        minutes: held.record.minutes + (now - held.record.lastSeenAt <= 3 * READ_MS ? (now - held.record.lastSeenAt) / 60_000 : 0),
        lastSeenAt: now
    };
    const justJoined = !sweep.loop.online.has(name.toLowerCase());
    if (held.fresh && justJoined) await noteNewcomer(sweep, name);
    const linkedOk = !settings.eligibility.linkedOnly || sweep.links.has(name.toLowerCase());
    const eligible = linkedOk && record.minutes >= settings.eligibility.minMinutes;
    if (!eligible) {
        await savePlayer(sweep.installedAppId, record);
        return;
    }
    const scores = progress.readList(await sweep.server.say([commands.listScores(name)]));
    record = await dealMissing(current, record, scores);
    const before = snapshot(record);
    for (const layer of play.LAYER_KEYS) {
        const layered = record[layer];
        const periodNow = sweep.state[layer];
        if (!layered || !periodNow || layered.key !== periodNow.key) continue;
        const instances: stored.Instance[] = [];
        for (const instance of layered.instances) {
            let next = creditStats(current, name, instance, periodNow, scores, false);
            next = await creditOther(current, next, periodNow, scores, seen, pace);
            instances.push(xrayVoid(sweep, name, next));
        }
        record = { ...record, [layer]: { ...layered, instances } };
    }
    if (sweep.state.daily) {
        const backlog: stored.Instance[] = [];
        for (const instance of record.backlog) {
            let next = creditStats(current, name, instance, sweep.state.daily, scores, false);
            next = await creditOther(current, next, sweep.state.daily, scores, seen, pace);
            backlog.push(xrayVoid(sweep, name, next));
        }
        record = { ...record, backlog };
    }
    record = await creditCommunity(current, record, scores);
    record = await settleAndCarry(sweep, record, true);
    await showProgress(sweep, record, before, justJoined);
    await savePlayer(sweep.installedAppId, record);
}

/** Each challenge's progress before a read, to tell what moved. */
function snapshot(record: stored.PlayerRecord): Map<string, number> {
    const found = new Map<string, number>();
    for (const layer of play.LAYER_KEYS) record[layer]?.instances.forEach((one, index) => found.set(play.refOf(layer, index), one.progress));
    record.backlog.forEach((one, index) => found.set(play.refOf("backlog", index), one.progress));
    return found;
}

/** What Polaris measures itself, and the reads that take a command per item. */
async function creditOther(
    sweep: ForPlayer,
    instance: stored.Instance,
    layer: stored.Period,
    scores: Readonly<Record<string, number>>,
    seen: plan.Seen,
    pace: Pace
): Promise<stored.Instance> {
    const template = templateOrNull(instance);
    if (!template || instance.doneAt !== null || instance.voided) return instance;
    const check = catalog.checkOf(template, instance.variant);
    const name = sweep.player;
    const values = progress.valuesOf(scores, layer.objectives);
    const look = (raw: number, extra: Partial<stored.Instance> = {}) =>
        progress.credit({ ...instance, ...extra }, template, raw, {
            now: sweep.now,
            active: true,
            afk: false,
            caps: false,
            gate: null,
            requirement: true,
            values
        });
    switch (check.kind) {
        case "held": {
            if (!pace.slow) return instance;
            let count = 0;
            for (const item of check.items) {
                const obtained = progress.partsSince(catalog.heldParts([item]), values, instance.base);
                if (obtained < 1) continue;
                if (progress.readHeld(await sweep.server.say([commands.heldCount(name, item)])) > 0) count += 1;
            }
            return look(count);
        }
        case "advancement": {
            if (!pace.slow) return instance;
            const had = instance.had ?? [];
            let count = 0;
            for (const id of check.ids) {
                if (had.includes(id)) continue;
                if (progress.passed(await sweep.server.say([commands.hasAdvancement(name, id)]))) count += 1;
            }
            return look(count);
        }
        case "criteria":
        case "advancements": {
            if (!pace.files) return instance;
            const file = await advancementsOf(sweep, name);
            if (file === null) return instance;
            const earned = progress.earnedSince(file, instance.dealtAt, check.kind === "criteria" ? check.ids : null);
            return look(earned.length);
        }
        case "polaris":
            return creditMeasure(sweep, instance, check, values, seen, look);
        default:
            return instance;
    }
}

function creditMeasure(
    sweep: Sweep,
    instance: stored.Instance,
    check: Extract<catalog.Check, { kind: "polaris" }>,
    values: Readonly<Record<string, number>>,
    seen: plan.Seen,
    look: (raw: number, extra?: Partial<stored.Instance>) => stored.Instance
): stored.Instance {
    const where = { x: seen.x, z: seen.z, dimension: seen.dimension ?? "minecraft:overworld" };
    const seconds = Math.max(1, (sweep.now - (instance.readAt ?? instance.dealtAt)) / 1000);
    switch (check.measure) {
        case "nether-distance":
            return look(instance.raw + progress.netherStep(instance.at, where, seconds), { at: where });
        case "villages": {
            const rose = check.parts ? progress.partsSince(check.parts, values, instance.last) > 0 : false;
            const cell = progress.cellOf(where.x, where.z, where.dimension);
            const cells = rose && !instance.cells.includes(cell) ? [...instance.cells, cell] : instance.cells;
            return look(cells.length, { cells });
        }
        case "together": {
            const me = seen;
            const active = (one: plan.Seen) =>
                one.movedAt !== null && sweep.now - one.movedAt <= sweep.settings.antiExploit.afkMinutes * 60_000;
            const near = [...sweep.seen.values()].some(
                (other) =>
                    other.name !== me.name &&
                    active(other) &&
                    (other.dimension ?? "") === (me.dimension ?? "") &&
                    Math.hypot(other.x - me.x, other.z - me.z) <= 64
            );
            const minutes = active(me) && near && instance.readAt !== null ? Math.min(seconds, (READ_MS * 2) / 1000) / 60 : 0;
            return look(instance.raw + minutes);
        }
        case "community-share": {
            const goal = running(sweep.state.goals, sweep.now)[0];
            if (!goal) return instance;
            const total = Object.values(goal.shares).reduce((sum, one) => sum + one.value, 0);
            const mine = goal.shares[seen.name.toLowerCase()]?.value ?? 0;
            return look(total > 0 ? Math.floor((mine / total) * 100) : 0);
        }
        default:
            // Events, trivia and greetings are counted as they happen
            // (`creditEventResults`, `welcome`); here they are only checked.
            return look(instance.raw);
    }
}

/** A player's advancements file, or null when it cannot be read. */
async function advancementsOf(sweep: Sweep, name: string): Promise<string | null> {
    const loop = sweep.loop;
    loop.level ??= await levelOf(sweep.server);
    if (!loop.uuids || !loop.uuids.has(name.toLowerCase())) loop.uuids = await uuidsOf(sweep.server);
    const uuid = loop.uuids.get(name.toLowerCase());
    if (!uuid) return null;
    return readContainerFile(sweep.server, `/data/${loop.level}/advancements/${uuid}.json`).catch(() => null);
}

/** A community goal's part for a player: dealt the first time they are seen
 *  during it, credited like any challenge. */
async function creditCommunity(
    sweep: ForPlayer,
    record: stored.PlayerRecord,
    scores: Readonly<Record<string, number>>
): Promise<stored.PlayerRecord> {
    const layer = sweep.state.community;
    if (!layer || !sweep.settings.layers.community) return record;
    const community = { ...record.community };
    const goals = running(sweep.state.goals, sweep.now);
    for (const goal of goals) {
        const values = progress.valuesOf(scores, layer.objectives);
        const mine =
            community[goal.id] ??
            progress.dealt({ template: goal.template, variant: goal.variant, tier: "hard", target: goal.target }, values, sweep.now);
        let next = creditStats(sweep, sweep.player, mine, layer, scores, false);
        next = xrayVoid(sweep, record.name, next);
        community[goal.id] = next;
        goal.shares[record.name.toLowerCase()] = { name: record.name, value: next.progress };
    }
    // Parts of goals that are over are let go.
    for (const id of Object.keys(community)) if (!sweep.state.goals.some((goal) => goal.id === id && !goal.finished)) delete community[id];
    return { ...record, community };
}

// ------------------------------------------------------------------ dealing

/**
 * Whatever a player has not been dealt this period, dealt now from the pool,
 * counting from their scores as they stand. A new day moves yesterday's
 * unfinished ones to the backlog, which is dealt again from today's pool.
 */
async function dealMissing(
    sweep: ForPlayer,
    record: stored.PlayerRecord,
    scores: Readonly<Record<string, number>>
): Promise<stored.PlayerRecord> {
    let next = record;
    const today = period.dayKey(sweep.clock, sweep.now);
    for (const layer of play.LAYER_KEYS) {
        const current = sweep.state[layer];
        if (!current || !current.applied || !sweep.settings.layers[layer]) continue;
        if (next[layer]?.key === current.key) continue;
        if (layer === "daily" && next.daily) next = play.toBacklog(next, next.daily, next.daily.key, today, period.dayNumber);
        // What was tracked belonged to the period that ended.
        const stale = layer === "daily" ? ["daily:", "backlog:"] : [`${layer}:`];
        if (stale.some((prefix) => next.tracked?.startsWith(prefix))) next = { ...next, tracked: null };
        const values = progress.valuesOf(scores, current.objectives);
        const entries = draw.deal(layer, current.pool, next.name, current.key);
        const instances: stored.Instance[] = [];
        for (const entry of entries) instances.push(await withFallback(sweep, layer, entry, values));
        next = { ...next, [layer]: { key: current.key, instances, rerolls: 0, swept: false, lines: [], full: false } };
        if (layer === "daily") next = { ...next, backlog: redeal(next, current, values, sweep.now) };
    }
    return next;
}

/**
 * A pool entry dealt to one player: an advancement they already have, or all
 * of whose criteria they already earned, becomes its fallback template.
 */
async function withFallback(
    sweep: ForPlayer,
    layer: catalog.Layer,
    entry: stored.PoolEntry,
    values: Readonly<Record<string, number>>
): Promise<stored.Instance> {
    const template = catalog.templateOf(entry.template);
    const check = template ? catalog.checkOf(template, entry.variant) : null;
    const fallback = template?.fallback ? catalog.templateOf(template.fallback) : null;
    const replaced = () => {
        const tier = entry.tier;
        const base = fallback ? (catalog.baseTarget(fallback, layer, tier) ?? catalog.baseTarget(fallback, layer, "hard") ?? 1) : 1;
        return progress.dealt(
            { template: fallback!.id, variant: fallback!.variants?.[0]?.key ?? null, tier, target: Math.max(1, Math.round(base * sweep.settings.multiplier)) },
            values,
            sweep.now
        );
    };
    if (check?.kind === "advancement") {
        const had: string[] = [];
        for (const id of check.ids) {
            if (progress.passed(await sweep.server.say([commands.hasAdvancement(sweep.player, id)]))) had.push(id);
        }
        if (fallback && had.length >= check.ids.length) return replaced();
        return progress.dealt(entry, values, sweep.now, { had });
    }
    if (check?.kind === "criteria" && fallback) {
        const file = await advancementsOf(sweep, sweep.player);
        if (file && check.ids.every((id) => advancementDone(file, id))) return replaced();
    }
    return progress.dealt(entry, values, sweep.now);
}

function advancementDone(file: string, id: string): boolean {
    try {
        const parsed = JSON.parse(file) as Record<string, { done?: boolean }>;
        return parsed[`minecraft:${id}`]?.done === true;
    } catch {
        return false;
    }
}

/**
 * The backlog dealt into a new day: one whose template is in today's pool and
 * that the player does not hold today goes on counting from today's objectives
 * with what it had got to; any other becomes a challenge of the same tier from
 * today's pool, from nothing. One that finds no home is let go.
 */
function redeal(record: stored.PlayerRecord, today: stored.Period, values: Readonly<Record<string, number>>, now: number): stored.Instance[] {
    const holding = new Set((record.daily?.instances ?? []).map((one) => one.template));
    const kept: stored.Instance[] = [];
    for (const one of record.backlog) {
        if (one.doneAt !== null) continue;
        if (Object.keys(one.base).length > 0 || one.readAt !== null) {
            // Already dealt into today.
            kept.push(one);
            holding.add(one.template);
            continue;
        }
        const same = today.pool.find((entry) => entry.template === one.template);
        if (same && !holding.has(one.template)) {
            kept.push({ ...one, base: { ...values }, last: { ...values }, raw: 0, offset: 0, dealtAt: now, readAt: now });
            holding.add(one.template);
            continue;
        }
        const other = today.pool.find((entry) => entry.tier === one.tier && !holding.has(entry.template));
        if (!other) continue;
        kept.push({ ...progress.dealt(other, values, now, { day: one.day }), readAt: now });
        holding.add(other.template);
    }
    return kept;
}

// ------------------------------------------------------------------ paying

async function settleAndCarry(sweep: Sweep, record: stored.PlayerRecord, online: boolean): Promise<stored.PlayerRecord> {
    const holder = holderOf(sweep.settings, sweep.ownerId, sweep.installedAppId, record.name, sweep.links);
    const ledger = await loadLedger(holder, sweep.season.key);
    const keys = {
        daily: sweep.state.daily?.key ?? null,
        weekly: sweep.state.weekly?.key ?? null,
        card: sweep.state.card?.key ?? null
    };
    // A period being closed is settled against its own key.
    const own = {
        daily: record.daily?.key ?? keys.daily,
        weekly: record.weekly?.key ?? keys.weekly,
        card: record.card?.key ?? keys.card
    };
    const settled = play.settle(record, ledger, sweep.context, own);
    if (settled.effects.length === 0) return record;
    await saveLedger(holder, settled.ledger);
    // Written before anything is handed out: a crash after this owes it, never pays it twice.
    await savePlayer(sweep.installedAppId, settled.record);
    await carry(sweep, record.name, online, settled.effects);
    return settled.record;
}

/** Effects carried out for one player: said and shown if they are on, rewards
 *  given - or kept for their next visit when they are not, or did not arrive. */
async function carry(sweep: Sweep, name: string, online: boolean, effects: readonly play.Effect[]): Promise<void> {
    if (!commands.PLAYER_NAME.test(name)) return;
    const language = sweep.settings.language;
    const said: string[] = [];
    const owed: { items: { id: string; count: number }[]; levels: number } = { items: [], levels: 0 };
    for (const effect of effects) {
        if (effect.kind === "tell" && online) said.push(commands.tell(name, effect.line));
        if (effect.kind === "title" && online) said.push(...commands.completion(name, effect.title, effect.subtitle));
        if (effect.kind !== "pay") continue;
        if (!online) {
            owed.items.push(...effect.payout.items);
            owed.levels += effect.payout.levels;
            continue;
        }
        const lines = commands.giveLines(name, effect.payout);
        for (const [index, line] of lines.items.entries()) {
            if (!commands.arrived(await sweep.server.say([line]))) owed.items.push(effect.payout.items[index]!);
        }
        if (lines.levels && !commands.arrived(await sweep.server.say([lines.levels]))) owed.levels += effect.payout.levels;
    }
    if (said.length > 0) await sweep.server.sayAll(said);
    if (owed.items.length === 0 && owed.levels === 0) return;
    if (online) await sweep.server.sayAll([commands.tell(name, messages.rewardWaiting(language))]);
    await owe(sweep.installedAppId, name, owed, language);
}

/**
 * A reward kept for somebody who is not on, in the events' queue of prizes
 * waiting: the events' sweep hands it over the next time they are seen.
 */
async function owe(
    installedAppId: string,
    name: string,
    reward: { items: { id: string; count: number }[]; levels: number },
    language: catalog.Language
): Promise<void> {
    const { updateEventState } = await import("../events/events-service");
    const { livePending } = await import("../events/state");
    const now = Date.now();
    // Split into rewards of at most six items, which is what the queue holds.
    const chunks: { items: { id: string; count: number }[]; levels: number }[] = [];
    for (let index = 0; index < Math.max(1, reward.items.length); index += 6) {
        chunks.push({ items: reward.items.slice(index, index + 6), levels: index === 0 ? reward.levels : 0 });
    }
    await updateEventState(installedAppId, (state) => ({
        ...state,
        pending: livePending(
            [
                ...state.pending,
                ...chunks.map((chunk, index) => ({
                    id: `challenge-${now.toString(36)}-${name.toLowerCase()}-${index}`,
                    player: name,
                    reward: chunk,
                    event: language === "es" ? "Retos" : "Challenges",
                    createdAt: now
                }))
            ],
            now
        )
    }));
}

// ------------------------------------------------------------------ showing progress

async function showProgress(sweep: Sweep, record: stored.PlayerRecord, before: Map<string, number>, justJoined: boolean): Promise<void> {
    const { settings, now } = sweep;
    const language = settings.language;
    const name = record.name;
    const lines: string[] = [];
    const tracked = play.lookup(record, record.tracked);
    const bar = commands.trackedBar(name);
    // Drawn again only when it moved, somebody joined, or it is a goal's (whose
    // progress is not in the snapshot).
    const moved =
        justJoined ||
        !sweep.loop.bars.has(bar) ||
        (record.tracked?.startsWith("goal:") ?? false) ||
        before.get(record.tracked ?? "") !== tracked?.progress;
    if (settings.display.bossBar && tracked) {
        const template = templateOrNull(tracked);
        if (template && moved) {
            lines.push(
                ...commands.barShow(
                    bar,
                    messages.trackedName(catalog.titleOf(template, tracked.variant, tracked.target, language), messages.figures(template, tracked.progress, tracked.target, language)),
                    tracked.progress,
                    tracked.target,
                    name,
                    tracked.doneAt !== null ? "green" : "yellow"
                )
            );
            sweep.loop.bars.add(bar);
        }
        // Finished: shown full once, then let go.
        if (tracked.doneAt !== null) record.tracked = null;
    } else if (sweep.loop.bars.has(bar)) {
        lines.push(commands.barRemove(bar));
        sweep.loop.bars.delete(bar);
    }
    if (settings.display.actionBar && now - record.toldAt >= TELL_EVERY_MS) {
        let best: { instance: stored.Instance; gain: number } | null = null;
        for (const [ref, was] of before) {
            const instance = play.lookup(record, ref);
            if (!instance || instance.doneAt !== null || instance.progress <= was) continue;
            const gain = ref === record.tracked ? Number.POSITIVE_INFINITY : (instance.progress - was) / Math.max(1, instance.target);
            if (!best || gain > best.gain) best = { instance, gain };
        }
        const template = best ? templateOrNull(best.instance) : null;
        if (best && template) {
            lines.push(
                commands.actionBar(
                    name,
                    messages.actionBar(
                        catalog.titleOf(template, best.instance.variant, best.instance.target, language),
                        messages.figures(template, best.instance.progress, best.instance.target, language)
                    )
                )
            );
            record.toldAt = now;
        }
    }
    if (justJoined && settings.display.joinMessage && settings.layers.daily) {
        const left = (record.daily?.instances ?? []).filter((one) => one.doneAt === null && !one.voided).length;
        lines.push(
            ...commands.fitted(name, [
                ...commands.parts(`${messages.joinLine(left, language)} `),
                commands.button(messages.MENU_BUTTON[language], messages.LABELS.listHover[language], commands.PRESS.list, "gold", sweep.context.spelling)
            ])
        );
    }
    if (lines.length > 0) await sweep.server.sayAll(lines);
}

// ------------------------------------------------------------------ the menu

/**
 * Who pressed a button, one line per player by the name the game knows them
 * by: `scoreboard players get` answers with the display name from 1.20.3 (a
 * team's prefix and suffix around it), glued to the next answer on vanilla,
 * and a Floodgate player is `.Name` - read with the events' own reader.
 */
async function pressesRead(server: ServerContainer): Promise<string> {
    const said = await server.say([commands.READ_PRESSES]);
    if (!/ has -?\d+ \[/.test(said)) return "";
    const read = replies.canonicalReplies(said, null);
    if (!read.needsRoster) return read.text;
    const roster = replies.rosterNames(await server.say([replies.ROSTER]).catch(() => ""));
    return replies.canonicalReplies(said, roster).text;
}

async function handlePresses(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    row: Row,
    settings: settingsModule.ChallengeSettings,
    now: number
): Promise<void> {
    const presses = progress.readPresses(await pressesRead(server));
    if (presses.size === 0) return;
    const sweep = await contextFor(installedAppId, loop, server, row, settings, now);
    const live: Sweep = { ...sweep, seen: playing.seenOn(installedAppId) ?? new Map() };
    const players = await loadPlayers(installedAppId, [...presses.keys()], now);
    for (const [name, value] of presses) {
        await server.sayAll(commands.pressHandled(name));
        const held = players.get(name.toLowerCase());
        if (!held || !commands.PLAYER_NAME.test(name)) continue;
        const lines = await answer(live, { ...held.record, name }, value).catch((error: unknown) => {
            console.warn("polaris: answering a challenges button failed", installedAppId, String(error));
            return [] as string[];
        });
        if (lines.length > 0) await server.sayAll(lines);
    }
}

/** What a button press does, and the lines that answer it. */
async function answer(sweep: Sweep, record: stored.PlayerRecord, value: number): Promise<string[]> {
    const { settings, context, now } = sweep;
    const language = settings.language;
    const name = record.name;
    const linkedOk = !settings.eligibility.linkedOnly || sweep.links.has(name.toLowerCase());
    if (!linkedOk) return [commands.tell(name, messages.notLinked(language))];
    if (record.minutes < settings.eligibility.minMinutes)
        return [commands.tell(name, messages.locked(settings.eligibility.minMinutes, language))];
    const holder = holderOf(settings, sweep.ownerId, sweep.installedAppId, name, sweep.links);
    const ledger = await loadLedger(holder, sweep.season.key);
    const list = () =>
        play.menu(name, record, ledger, context, {
            dayLeft: period.msToNextDay(sweep.clock, now),
            weekLeft: period.weekEndsAt(sweep.clock, now) - now,
            rerollsLeft: {
                daily: settings.rerolls.daily - (record.daily?.rerolls ?? 0),
                weekly: settings.rerolls.weekly - (record.weekly?.rerolls ?? 0)
            },
            goals: running(sweep.state.goals, now)
        });
    if (value === commands.PRESS.list) {
        if (!record.daily && !record.weekly) return [commands.tell(name, messages.nothingYet(language))];
        return list();
    }
    if (value === commands.PRESS.season) return play.seasonMenu(name, ledger, context);
    if (value === commands.PRESS.card) return play.cardMenu(name, record, context, period.monthEndsAt(sweep.clock, now) - now);
    if (value === commands.PRESS.goal) return play.goalMenu(name, record, sweep.state.goals, context);
    if (value === commands.PRESS.untrack) {
        await savePlayer(sweep.installedAppId, { ...record, tracked: null });
        sweep.loop.bars.delete(commands.trackedBar(name));
        return [commands.barRemove(commands.trackedBar(name)), commands.tell(name, messages.untracked(language))];
    }
    if (value >= commands.PRESS.reroll && value < commands.PRESS.reroll + 6) {
        const slot = value - commands.PRESS.reroll;
        const layer = slot < 3 ? "daily" : "weekly";
        return reroll(sweep, record, layer, slot % 3);
    }
    const trackRef =
        value >= commands.PRESS.track && value < commands.PRESS.track + 9
            ? (() => {
                  const slot = value - commands.PRESS.track;
                  return slot < 3 ? play.refOf("daily", slot) : slot < 6 ? play.refOf("weekly", slot - 3) : play.refOf("backlog", slot - 6);
              })()
            : value >= commands.PRESS.trackSquare && value < commands.PRESS.trackSquare + 9
              ? play.refOf("card", value - commands.PRESS.trackSquare)
              : value >= commands.PRESS.trackGoal && value < commands.PRESS.trackGoal + 5
                ? (() => {
                      const goal = running(sweep.state.goals, now)[value - commands.PRESS.trackGoal];
                      return goal ? `goal:${goal.id}` : null;
                  })()
                : null;
    if (trackRef) {
        const instance = play.lookup(record, trackRef);
        const template = instance ? templateOrNull(instance) : null;
        if (!instance || !template) return list();
        const next = { ...record, tracked: trackRef };
        await savePlayer(sweep.installedAppId, next);
        const title = catalog.titleOf(template, instance.variant, instance.target, language);
        sweep.loop.bars.add(commands.trackedBar(name));
        return [
            ...commands.barShow(
                commands.trackedBar(name),
                messages.trackedName(title, messages.figures(template, instance.progress, instance.target, language)),
                instance.progress,
                instance.target,
                name,
                "yellow"
            ),
            commands.tell(name, messages.tracking(title, language))
        ];
    }
    return list();
}

/** A challenge swapped for another of the same tier from the pool, counting
 *  from the player's scores as they are now - never a free completion. */
async function reroll(sweep: Sweep, record: stored.PlayerRecord, layer: "daily" | "weekly", index: number): Promise<string[]> {
    const { settings, now } = sweep;
    const language = settings.language;
    const name = record.name;
    const layered = record[layer];
    const current = sweep.state[layer];
    const instance = layered?.instances[index];
    const allowed = layer === "daily" ? settings.rerolls.daily : settings.rerolls.weekly;
    if (!layered || !current || layered.key !== current.key || !instance || instance.doneAt !== null || layered.rerolls >= allowed)
        return [commands.tell(name, messages.noReroll(language))];
    const entry = draw.reroll(current.pool, instance, layered.instances, `${name.toLowerCase()}:${current.key}:${layer}:${layered.rerolls}`);
    if (!entry) return [commands.tell(name, messages.noReroll(language))];
    const scores = progress.readList(await sweep.server.say([commands.listScores(name)]));
    const values = progress.valuesOf(scores, current.objectives);
    const fresh = await withFallback({ ...sweep, player: name }, layer, entry, values);
    const instances = layered.instances.map((one, at) => (at === index ? { ...fresh, readAt: now } : one));
    const tracked = record.tracked === play.refOf(layer, index) ? null : record.tracked;
    const next = { ...record, tracked, [layer]: { ...layered, instances, rerolls: layered.rerolls + 1 } };
    await savePlayer(sweep.installedAppId, next);
    return [commands.tell(name, messages.rerolled(play.titleOf(fresh, language), language))];
}

// ------------------------------------------------------------------ greeting newcomers

async function noteNewcomer(sweep: Sweep, name: string): Promise<void> {
    // Somebody Polaris has never counted may still be an old hand from before
    // challenges were switched on: only a player with no statistics file yet is new.
    const loop = sweep.loop;
    loop.level ??= await levelOf(sweep.server);
    loop.uuids = await uuidsOf(sweep.server);
    const uuid = loop.uuids.get(name.toLowerCase());
    if (!uuid) return;
    const stats = await readContainerFile(sweep.server, `/data/${loop.level}/stats/${uuid}.json`).catch(() => "");
    if (stats !== null) return;
    loop.newcomers.push({ name, at: sweep.now, greeters: [] });
}

/** Whoever said something in the chat soon after a newcomer's first join: the
 *  first three to do it, once per newcomer, count for Welcome a newcomer. */
async function welcome(sweep: Sweep, players: Map<string, Stored>): Promise<void> {
    const loop = sweep.loop;
    loop.newcomers = loop.newcomers.filter((one) => sweep.now - one.at <= WELCOME_MS + READ_MS);
    const size = await containerFileSize(sweep.server, LOG_FILE);
    if (size === null) return;
    const from = loop.logFrom === null || size < loop.logFrom ? size : loop.logFrom;
    loop.logFrom = size;
    if (loop.newcomers.length === 0 || size <= from) return;
    const log = await readContainerRange(sweep.server, LOG_FILE, from, size).catch(() => null);
    if (!log) return;
    // `<name>` is the display name: a team's prefix and suffix may sit around it.
    const roster = [...sweep.seen.values()].map((one) => one.name);
    const said = [...log.matchAll(/\]: (?:\[Not Secure\] )?<([^<>\n]{1,64})> (.+)$/gm)]
        .map((match) => replies.nameIn(match[1] as string, roster))
        .filter((name): name is string => name !== null);
    const credited = new Set<string>();
    for (const newcomer of loop.newcomers) {
        for (const speaker of said) {
            if (speaker.toLowerCase() === newcomer.name.toLowerCase()) continue;
            if (newcomer.greeters.length >= 3 || newcomer.greeters.includes(speaker.toLowerCase())) continue;
            newcomer.greeters.push(speaker.toLowerCase());
            credited.add(`${speaker.toLowerCase()}|${newcomer.name.toLowerCase()}`);
        }
    }
    for (const pair of credited) {
        const [speaker, newcomer] = pair.split("|") as [string, string];
        const held = players.get(speaker) ?? (await loadPlayers(sweep.installedAppId, [speaker], sweep.now)).get(speaker);
        if (!held || held.fresh || held.record.greeted.includes(newcomer)) continue;
        const record = bump({ ...held.record, greeted: [...held.record.greeted, newcomer].slice(-50) }, "welcome", 1);
        await savePlayer(sweep.installedAppId, record);
    }
}

/** One more of something Polaris counts, on every challenge of the player's
 *  that measures it this period. */
function bump(record: stored.PlayerRecord, measure: catalog.Measure, by: number): stored.PlayerRecord {
    const raise = (instance: stored.Instance) => {
        const template = catalog.templateOf(instance.template);
        const check = template ? catalog.checkOf(template, instance.variant) : null;
        if (!check || check.kind !== "polaris" || check.measure !== measure || instance.doneAt !== null) return instance;
        return { ...instance, raw: instance.raw + by };
    };
    let next = record;
    for (const layer of play.LAYER_KEYS) {
        const layered = next[layer];
        if (layered) next = { ...next, [layer]: { ...layered, instances: layered.instances.map(raise) } };
    }
    return { ...next, backlog: next.backlog.map(raise) };
}

// ------------------------------------------------------------------ events feeding challenges

export const eventResultSchema = z.object({
    participants: z.number().int(),
    ranked: z.array(z.string()),
    podium: z.array(z.string()),
    /** Trivia: rounds won, by name. */
    rounds: z.record(z.string(), z.number()).default({})
});
export type EventResult = z.infer<typeof eventResultSchema>;

/**
 * A finished event counted towards the challenges of those who took part: a
 * rank for Take part in events, a podium for Reach the podium, trivia rounds
 * won. Only events at least two people played count, so nobody earns it alone.
 * Counted into the stored progress; the next read hands out what it finishes.
 */
export async function creditEventResults(installedAppId: string, input: EventResult): Promise<void> {
    const parsed = eventResultSchema.safeParse(input);
    if (!parsed.success || parsed.data.participants < 2) return;
    const result = parsed.data;
    const row = await readRow(installedAppId);
    if (!row || !settingsOf(row.config).enabled) return;
    await inTurn(installedAppId, async () => {
        const names = [...new Set([...result.ranked, ...result.podium, ...Object.keys(result.rounds)])].filter((name) =>
            commands.PLAYER_NAME.test(name)
        );
        const players = await loadPlayers(installedAppId, names, Date.now());
        for (const name of names) {
            const held = players.get(name.toLowerCase());
            if (!held || held.fresh) continue;
            let record = held.record;
            if (result.ranked.some((one) => one.toLowerCase() === name.toLowerCase())) record = bump(record, "events-ranked", 1);
            if (result.podium.some((one) => one.toLowerCase() === name.toLowerCase())) record = bump(record, "events-podium", 1);
            const rounds = Object.entries(result.rounds).find(([one]) => one.toLowerCase() === name.toLowerCase())?.[1] ?? 0;
            if (rounds > 0) record = bump(record, "chat-games", rounds);
            if (record !== held.record) await savePlayer(installedAppId, record);
        }
    });
}

// ------------------------------------------------------------------ the sweep

/**
 * The minute sweep: a loop for every Minecraft server with challenges on whose
 * container is up, and every period that came round rotated - here as well as
 * in the loop, so a server whose loop is between two looks still gets its new
 * day on the minute.
 */
export async function sweepChallenges(now = Date.now()): Promise<{ running: number; rotated: number }> {
    const rows = await prisma.installedApp.findMany({
        where: { status: { not: "removed" }, catalogId: "minecraft" },
        select: { id: true, ownerId: true, config: true }
    });
    let rotated = 0;
    for (const row of rows) {
        const config = readInstallConfig(row.config);
        if (!(settingsModule.CHALLENGES_KEY in config)) continue;
        const settings = settingsOf(config);
        if (!settings.enabled) {
            if (loops.has(row.id)) await stopLoop(row.id);
            if (stored.readServerState(config).daily?.applied) {
                await withServerContainer(row.ownerId, row.id, async (server) => {
                    if (server.running) await inTurn(row.id, () => switchOff(row.id, server, { ownerId: row.ownerId, catalogId: "minecraft", config }));
                }).catch(() => undefined);
            }
            continue;
        }
        try {
            const due = await withServerContainer(row.ownerId, row.id, async (server) => server.running);
            if (!due) {
                if (loops.has(row.id)) await stopLoop(row.id);
                continue;
            }
            ensureLoop(row.ownerId, row.id);
            const loop = loops.get(row.id)!;
            await inTurn(row.id, async () => {
                if (!loop.link) loop.link = await openServerContainer(row.ownerId, row.id);
                const fresh = await readRow(row.id);
                if (!fresh) return;
                const sweep = await contextFor(row.id, loop, loop.link.server, fresh, settingsOf(fresh.config), now);
                const before = JSON.stringify([sweep.state.daily?.key, sweep.state.weekly?.key, sweep.state.card?.key]);
                await rotate({ ...sweep, seen: playing.seenOn(row.id) ?? new Map() });
                if (JSON.stringify([sweep.state.daily?.key, sweep.state.weekly?.key, sweep.state.card?.key]) !== before) rotated += 1;
            });
        } catch (error) {
            console.warn("polaris: challenges sweep failed", row.id, String(error));
        }
    }
    return { running: loops.size, rotated };
}

// ------------------------------------------------------------------ what the screen shows

export interface PlayerRow {
    readonly name: string;
    readonly lastSeenAt: number;
    readonly minutes: number;
    readonly daily: readonly InstanceView[];
    readonly weekly: readonly InstanceView[];
    readonly backlog: readonly InstanceView[];
    readonly cardDone: number;
    readonly lines: number;
    readonly points: number;
    readonly tier: number;
    readonly streak: number;
    readonly titles: readonly string[];
}

export interface InstanceView {
    readonly template: string;
    readonly variant: string | null;
    readonly tier: catalog.Difficulty;
    readonly target: number;
    readonly progress: number;
    readonly done: boolean;
    readonly voided: boolean;
}

export interface PoolView {
    readonly key: string;
    readonly endsAt: number;
    readonly entries: readonly (stored.PoolEntry & { dealt: number; done: number })[];
    readonly refused: readonly string[];
}

export interface ChallengesView {
    readonly settings: settingsModule.ChallengeSettings;
    readonly running: boolean;
    readonly version: string | null;
    readonly daily: PoolView | null;
    readonly weekly: PoolView | null;
    readonly card: PoolView | null;
    readonly tomorrow: readonly stored.PoolEntry[];
    readonly season: { readonly number: number; readonly startDay: string; readonly endDay: string; readonly daysLeft: number };
    readonly goals: readonly (stored.GoalState & { readonly total: number })[];
    readonly players: readonly PlayerRow[];
    readonly pace: Readonly<Record<string, number>>;
    readonly seasons: stored.ServerState["seasons"];
    readonly waiting: number;
    /** Why they cannot run here: a Bedrock server has no statistics to count with. */
    readonly refusal: "bedrock" | null;
}

const view = (instance: stored.Instance): InstanceView => ({
    template: instance.template,
    variant: instance.variant,
    tier: instance.tier,
    target: instance.target,
    progress: instance.progress,
    done: instance.doneAt !== null,
    voided: instance.voided
});

export async function challengesView(installedAppId: string): Promise<ChallengesView> {
    const row = await readRow(installedAppId);
    if (!row) throw new ChallengeRefusal("errors.notHere");
    const settings = settingsOf(row.config);
    const state = stored.readServerState(row.config);
    const now = Date.now();
    const clock = clockOf(settings);
    const seasonNow = period.seasonOf(clock, now, firstDayOf(settings, state, clock, now), settings.season.weeks);
    const rows = await prisma.minecraftChallengePlayer
        .findMany({ where: { installedAppId }, select: { player: true, playerName: true, data: true }, orderBy: { updatedAt: "desc" }, take: 200 })
        .catch(() => []);
    const records = rows.map((one) => stored.readPlayer(one.data, one.playerName, now));
    const links = await linksOf(installedAppId);
    // One query per scope (this server's, and a shared season's), not one per player.
    const holders = new Map(records.map((record) => [record.name.toLowerCase(), holderOf(settings, row.ownerId, installedAppId, record.name, links)]));
    const byScope = new Map<string, Set<string>>();
    for (const holder of holders.values()) byScope.set(holder.scope, (byScope.get(holder.scope) ?? new Set()).add(holder.holder));
    const found = new Map<string, string>();
    for (const [scope, wanted] of byScope) {
        const rows = await prisma.minecraftChallengeLedger
            .findMany({ where: { scope, holder: { in: [...wanted] } }, select: { holder: true, data: true } })
            .catch(() => []);
        for (const one of rows) found.set(`${scope}
${one.holder}`, one.data);
    }
    const ledgers = new Map<string, stored.Ledger>();
    for (const [name, holder] of holders) {
        ledgers.set(name, stored.readLedger(found.get(`${holder.scope}
${holder.holder}`) ?? null, seasonNow.key));
    }
    const poolView = (layer: Layer): PoolView | null => {
        const current = state[layer];
        if (!current) return null;
        return {
            key: current.key,
            endsAt: current.endsAt,
            refused: current.refused,
            entries: current.pool.map((entry) => {
                const holding = records.flatMap((record) =>
                    record[layer]?.key === current.key ? record[layer]!.instances.filter((one) => one.template === entry.template) : []
                );
                return { ...entry, dealt: holding.length, done: holding.filter((one) => one.doneAt !== null).length };
            })
        };
    };
    const tomorrowKey = period.dayKey(clock, now + 86_400_000);
    const tomorrow = drawFor(
        {
            settings,
            state: { ...state, recent: { ...state.recent, daily: [state.daily?.pool.map((one) => one.template) ?? [], ...state.recent.daily].slice(0, 3) } },
            installedAppId,
            loop: { version: state.version } as Loop
        },
        "daily",
        tomorrowKey
    );
    const eventState = readEventState(row.config);
    return {
        settings,
        running: loops.has(installedAppId),
        version: state.version,
        daily: poolView("daily"),
        weekly: poolView("weekly"),
        card: poolView("card"),
        tomorrow,
        season: { number: seasonNow.number, startDay: seasonNow.startDay, endDay: seasonNow.endDay, daysLeft: seasonNow.daysLeft },
        goals: state.goals
            .filter((goal) => !goal.finished || now - goal.endsAt < 7 * 86_400_000)
            .map((goal) => ({ ...goal, total: Object.values(goal.shares).reduce((sum, one) => sum + one.value, 0) })),
        players: records.map((record) => {
            const ledger = ledgers.get(record.name.toLowerCase()) ?? stored.readLedger(null, seasonNow.key);
            const day = period.dayKey(clock, now);
            return {
                name: record.name,
                lastSeenAt: record.lastSeenAt,
                minutes: Math.floor(record.minutes),
                daily: record.daily?.key === state.daily?.key ? (record.daily?.instances ?? []).map(view) : [],
                weekly: record.weekly?.key === state.weekly?.key ? (record.weekly?.instances ?? []).map(view) : [],
                backlog: record.backlog.filter((one) => one.doneAt === null).map(view),
                cardDone: record.card?.key === state.card?.key ? (record.card?.instances ?? []).filter((one) => one.doneAt !== null).length : 0,
                lines: record.card?.key === state.card?.key ? (record.card?.lines.length ?? 0) : 0,
                points: Math.floor(ledger.points),
                tier: season.tierOf(ledger.points, settings),
                streak: season.streakNow(ledger.streak, day, clock),
                titles: ledger.titles
            };
        }),
        pace: state.pace,
        seasons: state.seasons,
        waiting: eventState.pending.filter((one) => one.id.startsWith("challenge-")).length,
        refusal: editionOf(row.catalogId) === "bedrock" ? "bedrock" : null
    };
}

/** Forget one player's challenges on this server: they are dealt afresh. Their
 *  season points stay, and nothing is taken from them in the game. */
export async function resetPlayer(installedAppId: string, player: string): Promise<void> {
    await inTurn(installedAppId, async () => {
        await prisma.minecraftChallengePlayer.deleteMany({ where: { installedAppId, player: player.toLowerCase() } });
    });
}

/** For a test: every loop stopped, as a fresh process has. */
export async function stopAllLoops(): Promise<void> {
    for (const id of [...loops.keys()]) await stopLoop(id);
}

/** For a test: a loop's work done now, rather than on its timer. */
export async function runTick(installedAppId: string, now = Date.now(), read = true): Promise<void> {
    const loop = loops.get(installedAppId);
    if (!loop) return;
    // The loop's own timer may be halfway through a tick: this one waits for it.
    while (loop.busy) await new Promise((resolve) => setTimeout(resolve, 50));
    if (read) loop.lastRead = 0;
    await tick(installedAppId, now);
}

/** For a test: forget when things were last looked at, so the next tick looks again. */
export function forceSlowReads(installedAppId: string): void {
    const loop = loops.get(installedAppId);
    if (loop) {
        loop.lastSlow = 0;
        loop.lastFile = 0;
    }
}
