/**
 * Playing a world boss (`boss.ts`): the boss drawn and its rules held when the
 * event begins, its arena raised and the boss summoned, then every tick the
 * fight itself - who is fighting, its health grown for them, its phases and
 * shield, its attacks, keeping it from being trapped - and, once it is gone,
 * whether somebody felled it and who landed the final blow.
 *
 * The loop in `events-service.ts` owns the clock, the place-finding and the
 * saving, lent here as a `KindContext`. What a restart must know is on the run
 * (`run.boss`, and the arena and who is in it in `run.stage`), written down
 * before it happens; what it may forget - when each attack was last used - is
 * kept in memory.
 */

import * as boss from "./boss";
import * as stage from "./stage";
import * as catalog from "../catalog";
import * as speech from "../../speech";
import * as commands from "../commands";
import type * as stored from "../state";
import * as search from "../place-search";
import * as written from "./boss-messages";
import * as delivery from "../../delivery";
import * as eventWritten from "../messages";
import * as stageService from "./stage-service";
import type { ServerContainer } from "../../service";
import { EventStopped, type KindContext } from "./arena-service";

const say = speech.spoken(written);
const messages = speech.spoken(eventWritten);

/** How much ground the boss's lair is judged by around where it goes. */
const SPOT_RADIUS = 3;
/** How far from the players it is looked for. */
const DISTANCE = 24;
/** Ticks the arena's chunks get to load before its site is given up. */
const LOAD_WAITS = 3;
/** Never built closer to the ground than this, even under a low build limit. */
const LEAST_HEIGHT = 20;
/** On the land, a fighter further than this from it has it come to them. */
const CHASE_REACH = 16;
/** It wanders no further than this from its lair while nobody fights it. */
const LAIR_LEASH = 24;
/** Ticks it may stand still while it can reach nobody before it moves itself. */
const STUCK_TICKS = 3;
/** What it heals each tick nobody fights it, as a share of its health. */
const HEAL_SHARE = 0.02;
/** Between the warning of an attack and the attack. */
const WARNING_MS = 1_000;
/** How often everybody not up in the arena yet is told again where the beam is. */
const REMIND_EVERY_MS = 15_000;
/** How many fighters the damage ranking at the end names. */
const RANKED = 10;

const lower = (name: string) => name.toLowerCase();

interface Version {
    /** Attribute ids without `generic.` (1.21.2). */
    readonly ids: boolean;
    /** The `damage` and `ride` commands (1.19.4). */
    readonly damage: boolean;
    /** `marker` entities (1.17). */
    readonly markers: boolean;
    /** Item components (1.20.5). */
    readonly components: boolean;
    /** The highest block a structure may reach. */
    readonly top: number;
}

/** What one fight keeps in memory between ticks: nothing a restart needs. */
interface Memory {
    version: Version | null;
    /** Where it was last seen standing. */
    at: stored.Point | null;
    /** Its health at the last look, to tell what it lost since. */
    health: number | null;
    last: Partial<Record<boss.Ability, number>>;
    lastAny: number;
    still: number;
    alone: boolean;
    waits: number;
    /** Ticks the ground round the players has been waited for, for the beam. */
    /** When everybody not up yet was last told where the beam is. */
    remindedAt: number;
}

const memories = new Map<string, Memory>();

function memoryOf(runId: string): Memory {
    let memory = memories.get(runId);
    if (!memory) {
        memory = {
            version: null,
            at: null,
            health: null,
            last: {},
            lastAny: 0,
            still: 0,
            alone: false,
            waits: 0,
            remindedAt: 0
        };
        memories.set(runId, memory);
    }
    return memory;
}

/** The fight is over: nothing of it is kept. */
export function forget(runId: string): void {
    memories.delete(runId);
}

async function versionOf(ctx: KindContext, memory: Memory): Promise<Version> {
    if (memory.version) return memory.version;
    const [ids, damage, markers, components, from118] = await Promise.all([
        ctx.atLeast([1, 21, 2]),
        ctx.atLeast([1, 19, 4]),
        ctx.atLeast([1, 17]),
        ctx.atLeast([1, 20, 5]),
        ctx.atLeast([1, 18])
    ]);
    memory.version = { ids, damage, markers, components, top: from118 ? 319 : 255 };
    return memory.version;
}

function optionsOf(run: stored.EventRun): catalog.EventOptions<"world-boss"> {
    return run.preset.options as catalog.EventOptions<"world-boss">;
}

function stateOf(ctx: KindContext): boss.BossState {
    const run = ctx.run;
    if (run.boss) return run.boss;
    // Begun before this version knew what a drawn boss is: drawn now.
    const options = optionsOf(run);
    const fresh = boss.freshState(boss.draw(options, Math.random), options);
    ctx.run = { ...run, boss: fresh };
    return fresh;
}

function change(ctx: KindContext, patch: Partial<boss.BossState>): boss.BossState {
    const next = { ...stateOf(ctx), ...patch };
    ctx.run = { ...ctx.run, boss: next };
    return next;
}

function stageOf(ctx: KindContext): stage.StageState {
    return ctx.run.stage ?? stage.EMPTY_STAGE;
}

function changeStage(ctx: KindContext, patch: Partial<stage.StageState>): stage.StageState {
    const next = { ...stageOf(ctx), ...patch };
    ctx.run = { ...ctx.run, stage: next };
    return next;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ the start

/**
 * When the event begins: the boss drawn, and the rules the fight holds written
 * down and then set - `keepInventory` on, and `mobGriefing` off where the boss
 * could otherwise change a block. Answers the lines to send, or why it cannot
 * go ahead: a rule it cannot read is one it cannot hold or give back.
 */
export async function begin(
    ctx: KindContext
): Promise<{ lines: string[]; refused: string | null }> {
    const state = stateOf(ctx);
    const before: Record<string, string> = {};
    const lines: string[] = [];
    for (const rule of boss.heldRules(state.kind, state.arena)) {
        let held = false;
        for (const name of rule.names) {
            const value =
                ctx.run.gamerules[name] ??
                commands.readRuleValue(await ctx.server.say([commands.readRule(name)]));
            if (value === null) continue;
            before[name] = value;
            lines.push(commands.setRule(name, rule.value));
            held = true;
            break;
        }
        if (!held && rule.names === boss.MOB_GRIEFING) {
            return {
                lines: [],
                refused:
                    "The server would not say whether mobs may change blocks, so the boss could not promise to leave the world as it was"
            };
        }
    }
    ctx.run = { ...ctx.run, gamerules: { ...before, ...ctx.run.gamerules } };
    await ctx.persist();
    return { lines: [...lines, ...commands.bossScoreboard(state.kind)], refused: null };
}

// ------------------------------------------------------------------ each tick

/**
 * One tick of the fight. Answers a sentence once it is decided - felled, and by
 * whom - and null while it goes on.
 */
export async function tick(ctx: KindContext, lines: string[]): Promise<string | null> {
    const memory = memoryOf(ctx.run.id);
    const state = stateOf(ctx);
    if (!state.standing) {
        await raise(ctx, memory, lines);
        return null;
    }
    const language = ctx.language;
    const name = say.bossName(state.kind, language);
    const left = (ctx.run.endsAt - ctx.now) / 1000;
    lines.push(
        `bossbar set ${commands.BAR} name ${commands.text(`&c${eventWritten.barName(written.barTitle(state.kind, state.difficulty, ctx.home), left)}`)}`,
        `bossbar set ${commands.BAR} players @a`,
        commands.bossBarHealth(),
        ...commands.bossDamageTick()
    );
    const server = ctx.server;
    if (commands.readTest(await server.say([commands.BOSS_ALIVE])) !== "failed") {
        const at = commands.readPoint(await server.say([commands.BOSS_WHERE]));
        const previous = memory.at;
        memory.at = at ?? memory.at;
        const health = commands.readHealth(await server.say([commands.BOSS_HEALTH]));
        if (health !== null) {
            await creditUnseen(server, memory.health === null ? 0 : memory.health - health, null);
            memory.health = health;
        }
        lines.push(
            commands.BOSS_KILLS_RESET,
            boss.damageBarLine(state.arena, {
                en: written.yourDamage("en"),
                es: written.yourDamage("es")
            })
        );
        const lair = ctx.run.place;
        if (!state.arena && state.direct && lair) await bringToLair(ctx, lair, lines);
        await guide(ctx, memory, lines);
        if (at && health !== null) await fight(ctx, memory, { at, previous, health }, lines);
        return null;
    }
    // Gone from the world: killed, if somebody where it was last seen has a
    // kill of its kind since then - otherwise it is only out of reach,
    // somewhere nobody is.
    const last = memory.at ?? ctx.run.place;
    if (!last) return null;
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
    if (memory.at) {
        await creditUnseen(server, memory.health ?? 0, memory.at);
        await server.sayAll(commands.bossDamageAt(memory.at));
        memory.health = 0;
    }
    ctx.run = { ...ctx.run, decidedBy: by };
    await takeBackDrop(ctx, memory);
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
    const shooters = [
        ...commands.readScores(await server.say([commands.readShootersNear(at)])).keys()
    ];
    const shares = commands.unseenShares(lost * 10, melee, shooters);
    await server.sayAll([
        ...[...shares].map(([name, share]) => commands.shareLine(name, share)),
        ...commands.SHOTS_RESET
    ]);
}

/**
 * What it dropped on its death whatever its loot table says - the Wither's
 * star - gone: taken off the arena floor first, so nothing lying there can be
 * picked up after the count, then back from whoever holds more of it, unnamed,
 * than they came up with. Taking back needs item components (1.20.5 on), where
 * a trophy's name keeps it apart; before, only the floor is cleared.
 */
async function takeBackDrop(ctx: KindContext, memory: Memory): Promise<void> {
    const state = stateOf(ctx);
    const id = boss.BOSSES[state.kind].drops;
    const origin = stageOf(ctx).origin;
    if (!id || !origin) return;
    await ctx.server.sayAll(boss.looseDropLines(id, boss.arenaVolume(origin)));
    if (!(await versionOf(ctx, memory)).components) return;
    for (const saved of stageOf(ctx).saved) {
        const now = delivery.readCount(await ctx.server.say([boss.plainCountLine(saved.name, id)]));
        const extra = now === null ? 0 : now - (state.carried[saved.name] ?? now);
        if (extra > 0) await ctx.server.say([boss.takeBackLine(saved.name, id, extra)]);
    }
}

// ------------------------------------------------------------------ up to the boss standing

async function raise(ctx: KindContext, memory: Memory, lines: string[]): Promise<void> {
    const state = stateOf(ctx);
    const options = optionsOf(ctx.run);
    if (!state.arena) {
        const found = await ctx.findPlace(options.place, DISTANCE, SPOT_RADIUS);
        if (found === "failed") throw new EventStopped(search.NO_GROUND);
        if (!found) return;
        const near = commands.readWhere(
            await ctx.server.say([
                `execute in minecraft:overworld positioned ${found.x} ${found.y} ${found.z} as @a[distance=..${commands.BOSS_FIGHT_REACH},gamemode=!creative,gamemode=!spectator] run data get entity @s Pos`
            ])
        );
        const at = { x: found.x + 0.5, y: found.y, z: found.z + 0.5 };
        if (
            !(await summon(
                ctx,
                memory,
                at,
                near.map((one) => one.name)
            ))
        ) {
            await ctx.giveUpPlace(found);
            return;
        }
        // Everybody brought to it, like every other event, and sent back at the end.
        change(ctx, { direct: true, taken: [] });
        await ctx.persist();
        await announce(ctx, found, "land");
        return;
    }

    const origin = stageOf(ctx).origin;
    if (!origin) {
        const ground = await ctx.findPlace(
            options.place,
            DISTANCE,
            boss.ARENA_HALF + 1,
            "air",
            true
        );
        if (ground === "failed") throw new EventStopped(search.NO_AIR);
        if (!ground) return;
        const { top } = await versionOf(ctx, memory);
        let y = ground.y + boss.ARENA_HEIGHT;
        const over = boss.arenaVolume({ ...ground, y }).y2 - (top - 1);
        if (over > 0) y -= over;
        if (y - ground.y < LEAST_HEIGHT) {
            await ctx.giveUpPlace(ground);
            return;
        }
        const area = stage.areaOf(boss.arenaVolume({ ...ground, y }));
        // The boss is not standing until the arena is up: the place stays
        // open, and its column held, until then.
        changeStage(ctx, { origin: { x: ground.x, y, z: ground.z }, area, waits: 0 });
        ctx.run = { ...ctx.run, place: null };
        await ctx.persist();
        lines.push(stage.holdArea(area), commands.CLEAR_MARK);
        return;
    }

    const current = stageOf(ctx);
    if (!current.built) {
        await placeEntry(ctx);
        if (!(await provedEmpty(ctx, memory))) return;
        const boxes = boss.arenaBoxes(origin);
        // Written down first, then built - into air only.
        changeStage(ctx, { boxes: [...stageOf(ctx).boxes, ...boxes] });
        await ctx.persist();
        let whole = true;
        for (const box of boxes) {
            if (
                stage.fillCount(await ctx.server.say([stage.buildLine(box)])) !==
                stage.volumeOf(box)
            )
                whole = false;
        }
        changeStage(ctx, { built: true });
        await ctx.persist();
        if (!whole) throw new stageService.CalledOff("Its arena could not be built whole");
    }
    if (!(await summon(ctx, memory, boss.arenaCenter(origin), []))) {
        throw new stageService.CalledOff("The boss could not be summoned in its arena");
    }
    // Its place is where it stands, in the arena: the beam's own column is
    // never held or let go of, so a chunk somebody else keeps loaded stays so.
    const lift = stateOf(ctx).lift;
    ctx.run = { ...ctx.run, place: { x: origin.x, y: origin.y + 1, z: origin.z } };
    await ctx.persist();
    await announce(ctx, lift ?? origin, lift ? "beam" : "direct");
}

/**
 * How everybody reaches the arena: taken up, like every other event's players,
 * never made to walk to a beam (`direct`). A run that already has its beam
 * from before keeps it.
 */
async function placeEntry(ctx: KindContext): Promise<void> {
    const state = stateOf(ctx);
    if (state.lift || state.direct) return;
    change(ctx, { direct: true, taken: [] });
    await ctx.persist();
}

/**
 * Whether the arena's whole volume is empty air, proved by filling it with the
 * probe block using `keep` and comparing the count to its size, then taking the
 * probe out again either way. A site that is not empty is given up.
 */
async function provedEmpty(ctx: KindContext, memory: Memory): Promise<boolean> {
    const origin = stageOf(ctx).origin!;
    const volume = boss.arenaVolume(origin);
    const probes = stage.probeBoxes(volume);
    const kept = stageOf(ctx).boxes;
    changeStage(ctx, { boxes: [...kept, ...probes] });
    await ctx.persist();
    let filled = 0;
    let unloaded = false;
    for (const box of probes) {
        const count = stage.fillCount(await ctx.server.say([stage.buildLine(box)]));
        if (count === null) unloaded = true;
        else filled += count;
    }
    let cleared = true;
    for (const box of probes) {
        if (stage.fillCount(await ctx.server.say([stage.removeLine(box)])) === null)
            cleared = false;
    }
    if (cleared) changeStage(ctx, { boxes: kept });
    if (!unloaded && cleared && filled === stage.volumeOf(volume)) return true;
    if (unloaded && memory.waits < LOAD_WAITS) {
        memory.waits += 1;
        await ctx.persist();
        return false;
    }
    // The probe would not come out again: it stays written down, with the area
    // it needs held, for the end of the event to take out.
    if (!cleared) throw new stageService.CalledOff("The air its arena needs could not be checked");
    // Not empty - a tree, a hill, something of somebody's: somewhere else.
    // The beam stays where it was found: it was chosen by the players, not by
    // the arena's site.
    const area = stageOf(ctx).area;
    changeStage(ctx, { origin: null, area: null, waits: 0 });
    memory.waits = 0;
    await ctx.persist();
    if (area) await ctx.server.sayAll([stage.releaseArea(area)]);
    await ctx.giveUpPlace({ x: origin.x, y: origin.y - boss.ARENA_HEIGHT, z: origin.z });
    return false;
}

/**
 * The boss, standing at `at` with the health for whoever is already there:
 * attributes by the spelling this version takes, healed to full, named in the
 * server's language, armed. Answers false when it did not appear.
 */
async function summon(
    ctx: KindContext,
    memory: Memory,
    at: stored.Point,
    near: readonly string[]
): Promise<boolean> {
    const state = stateOf(ctx);
    const options = optionsOf(ctx.run);
    const version = await versionOf(ctx, memory);
    const fighters = near.filter(boss.isPlayer);
    const split = boss.splitHealth(
        boss.effectiveHealth(options.health, state.difficulty, fighters.length),
        boss.effectImmune(state.kind)
    );
    await ctx.server.sayAll(boss.summonLines(state.kind, state.difficulty, split.health, at));
    if (commands.readTest(await ctx.server.say([commands.BOSS_ALIVE])) !== "passed") return false;
    const other = boss.attributeLines(state.kind, state.difficulty, split.health, !version.ids);
    for (const [index, line] of boss
        .attributeLines(state.kind, state.difficulty, split.health, version.ids)
        .entries()) {
        if (!commands.attributeWorked(await ctx.server.say([line]))) {
            await ctx.server.say([other[index] as string]);
        }
    }
    const name = written.bossName(state.kind, ctx.home);
    const profile = boss.BOSSES[state.kind];
    await ctx.server.sayAll([
        commands.bossHeal(split.health),
        // Both ways a name has been written, the older first: up to 1.21.4 the
        // newer is not a name at all and is passed over; from 1.21.5 the older
        // would show as its own text, and the newer replaces it.
        commands.bossNameCommand(name, false),
        commands.bossNameCommand(name, true),
        ...boss.bossEquipLines(state.kind),
        ...boss.upkeepLines(
            { ...state, resistance: split.resistance },
            { rides: false, shield: false }
        ),
        ...(profile.guard > 0
            ? boss.minionLines(state.kind, profile.guard, false, state.difficulty)
            : []),
        commands.CLEAR_MARK,
        `bossbar set ${commands.BAR} max ${split.health}`,
        boss.barColorLine(1)
    ]);
    // Its first look sets where its health is counted from, as it always has.
    memory.health = null;
    memory.at = { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) };
    change(ctx, {
        standing: true,
        max: split.health,
        resistance: split.resistance,
        fighters: [...new Set(fighters)]
    });
    await ctx.persist();
    return true;
}

/** How the fight is reached: on the land, by the beam up to its arena, or
 *  taken up to it with no beam to walk into. */
type Reached = "land" | "beam" | "direct";

async function announce(ctx: KindContext, where: stored.Point, how: Reached): Promise<void> {
    const state = stateOf(ctx);
    const language = ctx.language;
    const name = say.bossName(state.kind, language);
    const said = {
        land: () => messages.bossAppeared(name, where.x, where.y, where.z, language),
        beam: () => say.inArena(name, where.x, where.y, where.z, language),
        direct: () => say.takenUp(name, language)
    }[how]();
    await ctx.server.sayAll([
        commands.say(messages.tag(language) + said),
        // On everybody's screen too, where the beam up is: a line in the chat
        // scrolls away, and nobody knew to walk into the light.
        ...(how === "beam"
            ? commands.titleCommands(
                  `&c${name}`,
                  say.beamSubtitle(where.x, where.y, where.z, language)
              )
            : how === "direct"
              ? commands.titleCommands(`&c${name}`, say.takenUpSubtitle(language))
              : []),
        commands.sound(commands.SOUNDS.boss)
    ]);
    memoryOf(ctx.run.id).remindedAt = ctx.now;
}

/**
 * Everybody in the Overworld who is not fighting yet shown the way: in the
 * arena's case the beam up - how far, and an arrow from where they look - with
 * the beam's place said again in the chat every `REMIND_EVERY_MS`; on the
 * land, the boss itself, for whoever is out of its reach.
 */
async function guide(ctx: KindContext, memory: Memory, lines: string[]): Promise<void> {
    const state = stateOf(ctx);
    const target = state.arena ? state.lift : memory.at;
    if (!target) return;
    const players = commands
        .readWhere(await ctx.server.say([commands.IN_OVERWORLD]))
        .filter((one) => boss.isPlayer(one.name));
    const up = new Set(stageOf(ctx).saved.map((one) => lower(one.name)));
    const away = players.filter((one) =>
        state.arena
            ? !up.has(lower(one.name))
            : Math.hypot(one.x - target.x, one.y - target.y, one.z - target.z) >
              commands.BOSS_FIGHT_REACH
    );
    if (away.length === 0) return;
    const facing = commands.readFacing(await ctx.server.say([commands.FACING]));
    const name = say.bossName(state.kind, ctx.home);
    const center = { x: target.x + 0.5, z: target.z + 0.5 };
    for (const one of away) {
        const meters = Math.round(Math.hypot(one.x - center.x, one.z - center.z));
        const arrow = commands.arrowTo(one, facing.get(one.name)?.yaw ?? 0, center);
        lines.push(
            commands.actionbarFor(
                one.name,
                state.arena
                    ? say.beamGuide(meters, arrow, speech.EVERY)
                    : say.bossGuide(name, meters, arrow)
            )
        );
    }
    if (state.arena && ctx.now - memory.remindedAt >= REMIND_EVERY_MS) {
        memory.remindedAt = ctx.now;
        const line = commands.text(
            messages.tag(speech.EVERY) +
                say.beamReminder(target.x, target.y, target.z, speech.EVERY)
        );
        for (const one of away) lines.push(`tellraw ${one.name} ${line}`);
    }
}

// ------------------------------------------------------------------ the fight

interface Seen {
    readonly at: stored.Point;
    readonly previous: stored.Point | null;
    readonly health: number;
}

async function fight(ctx: KindContext, memory: Memory, seen: Seen, lines: string[]): Promise<void> {
    const version = await versionOf(ctx, memory);
    const server = ctx.server;
    const language = ctx.language;
    let state = stateOf(ctx);
    const name = say.bossName(state.kind, language);
    const origin = state.arena ? stageOf(ctx).origin : null;

    // Who is fighting it.
    let near: { name: string; x: number; y: number; z: number }[];
    if (origin) {
        near = await arenaTick(ctx, origin, lines);
    } else {
        near = commands
            .readWhere(await server.say([boss.fightersWhere(false)]))
            .filter((one) => boss.isPlayer(one.name));
    }

    // Its health grown for anybody new.
    const known = new Set(state.fighters.map(lower));
    const fresh = [...new Set(near.map((one) => one.name))].filter((one) => !known.has(lower(one)));
    let health = seen.health;
    if (fresh.length > 0) {
        const options = optionsOf(ctx.run);
        const count = state.fighters.length + fresh.length;
        const before = { health: state.max, resistance: state.resistance };
        const was = boss.effectiveHealth(options.health, state.difficulty, state.fighters.length);
        const now = boss.effectiveHealth(options.health, state.difficulty, count);
        const after = boss.splitHealth(now, boss.effectImmune(state.kind));
        state = change(ctx, { fighters: [...state.fighters, ...fresh] });
        if (now > was) {
            health = boss.toppedUp(health, before, after, now - was);
            const other = boss.maxHealthLine(after.health, !version.ids);
            if (
                !commands.attributeWorked(
                    await server.say([boss.maxHealthLine(after.health, version.ids)])
                )
            )
                await server.say([other]);
            await server.sayAll([
                boss.healLine(health),
                `bossbar set ${commands.BAR} max ${after.health}`
            ]);
            memory.health = health;
            state = change(ctx, { max: after.health, resistance: after.resistance });
            if (count > 1)
                lines.push(
                    boss.tellFighters(
                        state.arena,
                        messages.tag(language) + say.stronger(name, count, language)
                    )
                );
        }
        await ctx.persist();
    }

    // Its phase.
    const phase = Math.max(state.phase, boss.phaseFor(health, state.max)) as boss.Phase;
    const summonedNow = phase >= 2 && state.phase < 2;
    if (phase > state.phase) {
        for (let next = state.phase + 1; next <= phase; next += 1) {
            if (next === 2) {
                const count = boss.minionCount(
                    state.difficulty,
                    Math.max(1, state.fighters.length)
                );
                lines.push(
                    boss.barColorLine(2),
                    ...boss.titleToFighters(
                        state.arena,
                        say.phaseTitle(2, language),
                        say.phaseSubtitle(2, language)
                    ),
                    commands.say(messages.tag(language) + say.shieldUp(name, language)),
                    ...boss.minionLines(state.kind, count, true, state.difficulty),
                    boss.soundAt("minecraft:entity.evoker.prepare_summon", 0.7)
                );
            } else {
                lines.push(
                    boss.barColorLine(3),
                    ...boss.titleToFighters(
                        state.arena,
                        say.phaseTitle(3, language),
                        say.phaseSubtitle(3, language)
                    ),
                    commands.say(messages.tag(language) + say.rageLine(name, language)),
                    ...(boss.effectImmune(state.kind) ? boss.immuneRageLines() : []),
                    boss.soundAt("minecraft:entity.ender_dragon.growl", 1)
                );
            }
        }
        state = change(ctx, { phase, shielded: state.shielded || phase >= 2 });
        await ctx.persist();
    }

    // Its shield, while any minion of the second phase lives.
    let shield = state.shielded && !state.broken;
    // Minions summoned this tick are still only in the batch: counted from the next.
    if (shield && !summonedNow) {
        const answer = commands.readTest(await server.say([boss.SHIELD_LEFT]));
        if (answer === "failed") {
            shield = false;
            state = change(ctx, { broken: true });
            await ctx.persist();
            lines.push(
                ...boss.SHIELD_DOWN,
                ...boss.titleToFighters(state.arena, say.shieldBroken(language), ""),
                commands.say(messages.tag(language) + say.shieldBroken(language)),
                boss.soundAt("minecraft:block.glass.break", 0.8)
            );
        }
    }
    if (shield) lines.push(boss.SHIELD_SHOWN);

    lines.push(
        ...boss.upkeepLines(state, { rides: version.damage, shield }),
        boss.spareBystanders(),
        ...boss.ADOPT_SUMMONED,
        boss.LEASH_MOBS
    );

    // Never trapped, never left alone.
    const distances = near.map((one) => ({
        name: one.name,
        away: Math.hypot(one.x - (seen.at.x + 0.5), one.y - seen.at.y, one.z - (seen.at.z + 0.5))
    }));
    distances.sort((a, b) => a.away - b.away);
    const nearest = distances[0] ?? null;
    const farthest = distances[distances.length - 1] ?? null;
    if (origin && !boss.insideArena(origin, seen.at)) {
        const center = boss.arenaCenter(origin);
        lines.push(boss.homeLine(center));
    } else if (!nearest) {
        // Every fighter has gone: it heals, slowly, and keeps to its lair.
        if (health < state.max) {
            health = Math.min(state.max, health + state.max * HEAL_SHARE);
            lines.push(boss.healLine(health));
            memory.health = Math.round(health);
            if (!memory.alone)
                lines.push(commands.say(messages.tag(language) + say.healing(name, language)));
        }
        memory.alone = true;
        const lair = ctx.run.place;
        if (!origin && lair && Math.hypot(seen.at.x - lair.x, seen.at.z - lair.z) > LAIR_LEASH)
            lines.push(boss.homeLine({ x: lair.x + 0.5, y: lair.y, z: lair.z + 0.5 }));
    } else {
        memory.alone = false;
        const moved = seen.previous
            ? Math.hypot(
                  seen.at.x - seen.previous.x,
                  seen.at.y - seen.previous.y,
                  seen.at.z - seen.previous.z
              )
            : Number.POSITIVE_INFINITY;
        // Standing still is being trapped - even right against somebody, with
        // a wall between them; brought beside them, where it already stood, it
        // loses nothing. One that fights from a distance stands still to cast
        // or shoot, and is trapped only when blocks close it in on every side.
        const ranged = boss.BOSSES[state.kind].ranged === true;
        const stuck =
            moved < 1 &&
            (!ranged || commands.readTest(await server.say([boss.ENCLOSED])) === "passed");
        memory.still = stuck ? memory.still + 1 : 0;
        const inWater =
            !origin && commands.readTest(await server.say([boss.IN_WATER])) === "passed";
        if ((!origin && nearest.away > CHASE_REACH) || memory.still >= STUCK_TICKS || inWater) {
            lines.push(boss.besideLine(nearest.name));
            memory.still = 0;
        }
    }

    // One of its attacks, warned of a second before it lands.
    if (nearest) {
        const ability = boss.nextAbility(
            memory.last,
            memory.lastAny,
            ctx.now,
            state.difficulty,
            state.phase as boss.Phase,
            farthest?.away ?? 0
        );
        if (ability) {
            const planned = boss.abilityLines(ability, {
                arena: state.arena,
                difficulty: state.difficulty,
                damage: version.damage,
                target: ability === "leap" ? (farthest?.name ?? null) : null,
                warning: say.warning(ability, state.arena, speech.EVERY),
                markers: version.markers
            });
            memory.last[ability] = ctx.now;
            memory.lastAny = ctx.now;
            if (planned.warn.length > 0) {
                // What led up to it goes first, so the warning is not held back.
                await server.sayAll(lines.splice(0, lines.length));
                await server.sayAll(planned.warn);
                await sleep(WARNING_MS);
                await server.sayAll(planned.act);
            }
        }
    }
}

/**
 * The arena's side of a tick: the beam, whoever stepped into it brought up
 * (written down first), anybody who fell caught and put back, anybody who left
 * let go. Answers the fighters inside.
 */
async function arenaTick(
    ctx: KindContext,
    origin: stored.Point,
    lines: string[]
): Promise<{ name: string; x: number; y: number; z: number }[]> {
    const server = ctx.server;
    const language = ctx.language;
    const state = stateOf(ctx);
    const lift = state.lift;
    if (lift) {
        lines.push(...boss.liftBeam(lift));
        const stepping = commands
            .readWhere(await server.say([boss.inLift(lift)]))
            .map((one) => one.name);
        if (stepping.length > 0) await admit(ctx, stepping, arenaWay(origin), lines);
    } else if (state.direct) {
        // No beam: everybody in the Overworld taken up, once each.
        const taken = new Set(state.taken);
        const fresh = commands
            .readWhere(await server.say([boss.NOT_UP]))
            .map((one) => one.name)
            .filter((name) => !taken.has(lower(name)));
        if (fresh.length > 0) await admit(ctx, fresh, arenaWay(origin), lines);
    }
    const where = commands.readWhere(await server.say([stage.ARENA_WHERE]));
    const dimensions = commands.readDimensions(await server.say([stage.ARENA_DIMENSIONS]));
    const inside: { name: string; x: number; y: number; z: number }[] = [];
    let saved = stageOf(ctx).saved;
    let changed = false;
    for (const one of where) {
        const kept = saved.find((each) => lower(each.name) === lower(one.name));
        if (!kept) continue;
        if (boss.leftArena(origin, one, dimensions.get(one.name))) {
            const note = state.lift ? say.leftArena(language) : say.leftArenaForGood(language);
            lines.push(...boss.letGoLines(kept, messages.tag(language) + note));
            saved = saved.filter((each) => each !== kept);
            changed = true;
            continue;
        }
        if (boss.underArena(origin, one)) {
            const index = saved.indexOf(kept);
            lines.push(...boss.catchLines(kept.name, boss.arenaSpot(origin, index)));
        }
        inside.push(one);
    }
    if (changed) {
        changeStage(ctx, { saved });
        await ctx.persist();
    }
    return inside;
}

/** Where each one brought in stands, and the lines that take them there. */
interface Way {
    readonly spot: (index: number) => stage.Spot;
    readonly lines: (name: string, spot: stage.Spot) => string[];
}

function arenaWay(origin: stored.Point): Way {
    return { spot: (index) => boss.arenaSpot(origin, index), lines: boss.admitLines };
}

/**
 * On the land, everybody in the Overworld not brought yet taken to the boss's
 * lair, once each: somebody who walks off is never pulled back mid-fight.
 */
async function bringToLair(ctx: KindContext, lair: stored.Point, lines: string[]): Promise<void> {
    const taken = new Set(stateOf(ctx).taken);
    const fresh = commands
        .readWhere(await ctx.server.say([boss.NOT_UP]))
        .map((one) => one.name)
        .filter((name) => !taken.has(lower(name)));
    if (fresh.length === 0) return;
    await admit(
        ctx,
        fresh,
        { spot: (index) => boss.landSpot(lair, index), lines: boss.landAdmitLines },
        lines
    );
}

/** Into the fight: where each stood written down first, then moved. */
async function admit(
    ctx: KindContext,
    names: readonly string[],
    way: Way,
    lines: string[]
): Promise<void> {
    const server = ctx.server;
    const owed = await ctx.owed();
    const wanted = names.filter((name) => boss.isPlayer(name) && !owed.has(lower(name)));
    if (wanted.length === 0) return;
    const where = commands.readWhere(await server.say([commands.WHERE]));
    const facing = commands.readFacing(await server.say([commands.FACING]));
    const dimensions = commands.readDimensions(await server.say([commands.DIMENSIONS]));
    const modes = stage.readGameModes(await server.say([stage.GAME_MODES]));
    const current = stageOf(ctx);
    const fresh: stage.Saved[] = [];
    for (const name of wanted) {
        if (current.saved.some((one) => lower(one.name) === lower(name))) continue;
        const saved = stage.savedFrom(name, where, facing, dimensions, modes);
        if (saved) fresh.push(saved);
    }
    if (fresh.length === 0) return;
    const all = [...current.saved, ...fresh];
    changeStage(ctx, { saved: all });
    // Taken up with no beam: never pulled up again once they leave.
    if (stateOf(ctx).direct) {
        const taken = new Set([...stateOf(ctx).taken, ...fresh.map((one) => lower(one.name))]);
        change(ctx, { taken: [...taken] });
    }
    // What they carry of what the boss drops anyway: theirs, never taken back.
    const drops = boss.BOSSES[stateOf(ctx).kind].drops;
    if (drops && (await versionOf(ctx, memoryOf(ctx.run.id))).components) {
        const carried = { ...stateOf(ctx).carried };
        for (const one of fresh) {
            const count = delivery.readCount(
                await server.say([boss.plainCountLine(one.name, drops)])
            );
            if (count !== null) carried[one.name] = count;
        }
        change(ctx, { carried });
    }
    // Nobody is moved until where they were is kept.
    await ctx.persist();
    const state = stateOf(ctx);
    for (const one of fresh) {
        const spot = way.spot(all.indexOf(one));
        lines.push(
            ...way.lines(one.name, spot),
            `title ${one.name} times 5 40 10`,
            `title ${one.name} subtitle ${commands.text(`&e${say.bossName(state.kind, ctx.language)}`)}`,
            `title ${one.name} title ${commands.text(say.enteredTitle(ctx.language))}`
        );
    }
}

// ------------------------------------------------------------------ the end

/** The name it went by, in every language. */
export function nameOf(run: stored.EventRun, language: speech.Speech): string {
    const kind = run.boss?.kind ?? optionsOf(run).boss;
    return say.bossName(kind, language);
}

/** The prizes this fight pays, multiplied for its difficulty. */
export function rewardsOf(run: stored.EventRun): catalog.Rewards {
    const difficulty = run.boss?.difficulty ?? optionsOf(run).difficulty;
    return boss.scaledRewards(run.preset.rewards, difficulty);
}

/** Everything the fight summoned out of the world, before its arena comes down. */
export function mobsGone(): string[] {
    return boss.bossCleanup();
}

/** Who wins and who takes the trophy, by the rule the event was set to (`boss.ts`). */
export const podiumOf = boss.podiumOf;
export const trophyWinner = boss.trophyWinner;

/** Everybody's damage at the end, most first, as one line; null when nobody dealt any. */
export function rankingLine(
    scores: ReadonlyMap<string, number>,
    disqualified: ReadonlySet<string>,
    language: speech.Speech
): string | null {
    const entries = boss.ranking(scores, disqualified, RANKED);
    return entries.length > 0 ? say.damageRanking(entries, language) : null;
}

/** The trophy a fight pays, as it is rebuilt to be handed over; null with no boss drawn. */
export function trophyOf(run: stored.EventRun): boss.Trophy | null {
    if (!run.boss) return null;
    return {
        kind: run.boss.kind,
        difficulty: run.boss.difficulty,
        winner: optionsOf(run).winner ?? "damage"
    };
}

/**
 * The trophy handed to its winner (`trophyWinner`): counted on them before and
 * after, like every prize, so what fell at their feet is known. Answers what
 * reached them, or null when nothing was given.
 */
export async function awardTrophy(
    server: ServerContainer,
    trophy: boss.Trophy,
    home: catalog.Language,
    spelling: boss.NameSpelling,
    to: string
): Promise<delivery.DeliveredItem | null> {
    if (!boss.isPlayer(to)) return null;
    const winner = trophy.winner;
    const args = boss.trophyArguments(
        written.trophyName(trophy.kind, home),
        written.trophyLore(trophy.difficulty, winner, home),
        spelling
    );
    const before = delivery.readCount(await server.say([delivery.countLine(to, boss.TROPHY_ITEM)]));
    for (const argument of args) {
        const answer = await server.say([`give ${to} ${argument} 1`]);
        if (!commands.gaveIt(answer)) continue;
        const after = delivery.readCount(
            await server.say([delivery.countLine(to, boss.TROPHY_ITEM)])
        );
        const kept =
            before !== null && after !== null ? Math.min(1, Math.max(0, after - before)) : 1;
        await server.sayAll([
            `tellraw ${to} ${commands.text(messages.tag(speech.EVERY) + say.trophyGiven(winner, speech.EVERY))}`
        ]);
        return {
            id: boss.TROPHY_ITEM,
            count: 1,
            dropped: 1 - kept,
            label: delivery.labelIn(answer)
        };
    }
    return null;
}
