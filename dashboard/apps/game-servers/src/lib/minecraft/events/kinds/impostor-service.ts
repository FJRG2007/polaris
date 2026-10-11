/**
 * Playing impostor (`impostor.ts`): the arena's own steps are
 * `arena-service`'s; this is its part of them.
 *
 * At "Go!" everybody is seated round the table, the impostors are drawn and
 * told - each impostor who the others are - and every player is told their
 * tasks, all of it written into the run before anything else happens, so a
 * restart draws nobody again.
 *
 * Each look - every second - reads where everybody is, the hits since the last
 * one (the events data pack's, or the damage counts where it is not on), the
 * presses since the last one (`impostor.PRESS`: a switch or button worked, the
 * emergency button, a body right-clicked, a ballot clicked) and the chat. Out
 * of a meeting it then: puts out whoever has been gone from the server for
 * `MISSING_MS`; kills a crew member hit by an impostor whose kill is ready,
 * leaving a body; takes an impostor standing on a vent to its pair; counts the
 * tasks done; and calls a meeting for a body reported or the button pressed.
 * In a meeting it keeps everybody in their seat, hands out the ballots once
 * the talking is over, takes the votes and, when they are all in or the time
 * is up, votes out whoever had the most. Then it decides (`impostor.verdict`).
 * Every change is written into the run as it happens.
 */

import * as hits from "./hits";
import * as arena from "./arena";
import * as im from "./impostor";
import * as catalog from "../catalog";
import * as speech from "../../speech";
import * as written from "../messages";
import * as commands from "../commands";
import type * as stored from "../state";
import * as said from "./impostor-messages";
import * as hitsService from "./hits-service";
import type { ArenaGame, KindContext } from "./arena-game";
import { radarLine, RADAR_OFF, RADAR_RESET } from "./radar";

const messages = speech.spoken(written);
const imMessages = speech.spoken(said);

const lower = (name: string) => name.toLowerCase();

function optionsOf(run: stored.EventRun): catalog.EventOptions<"impostor"> {
    return run.preset.options as catalog.EventOptions<"impostor">;
}

/** A run's station, drawn once and kept, with its plan from above. */
const layouts = new Map<string, { layout: im.Layout; plan: im.Cell[][] }>();

function stationOf(run: stored.EventRun): { layout: im.Layout; plan: im.Cell[][] } {
    const box = run.arena!.box;
    const key = `${run.id}:${box.x1}:${box.y1}:${box.z1}:${box.z2}`;
    let found = layouts.get(key);
    if (!found) {
        if (layouts.size >= 8) layouts.delete(layouts.keys().next().value!);
        const layout = im.layoutFor(run.id, box);
        found = { layout, plan: im.planOf(layout) };
        layouts.set(key, found);
    }
    return found;
}

function layoutOf(run: stored.EventRun): im.Layout {
    return stationOf(run).layout;
}

/** What one run keeps between looks: nothing that must survive a restart. */
interface Memory {
    dealt: hits.Tally;
    taken: hits.Tally;
    /** When each player was first seen gone from the server, this time. */
    missing: Map<string, number>;
    /** Who was on the server at the last look. */
    seen: Set<string>;
    /** Who stands on which plate, since when. */
    scanning: Map<string, { station: number; since: number }>;
    /** Who was shown the button for which body: once each. */
    told: Set<string>;
    /** When each impostor last came out of a vent. */
    vented: Map<string, number>;
}

const memories = new Map<string, Memory>();

function memoryOf(runId: string): Memory {
    let memory = memories.get(runId);
    if (!memory) {
        if (memories.size >= 16) memories.delete(memories.keys().next().value!);
        memory = {
            dealt: hits.tally(),
            taken: hits.tally(),
            missing: new Map(),
            seen: new Set(),
            scanning: new Map(),
            told: new Set(),
            vented: new Map()
        };
        memories.set(runId, memory);
    }
    return memory;
}

/** What was written as the station was built: its design, era and rows. */
function builtOf(run: stored.EventRun): Partial<im.ImpostorState> {
    const parsed = im.stateSchema.partial().safeParse(run.game ?? {});
    return parsed.success ? parsed.data : {};
}

function eraOf(run: stored.EventRun): im.Era {
    return builtOf(run).era ?? im.OLDEST;
}

/** The game as "Go!" leaves it: the roles drawn, the tasks given, the first
 *  kill and the button waiting. */
function firstState(run: stored.EventRun, now: number): im.ImpostorState {
    const options = optionsOf(run);
    const names = run.entrants.map((one) => one.name);
    const layout = layoutOf(run);
    const impostors = im.impostorsFor(run.id, names, options.impostors);
    const count = Math.min(options.tasks, layout.stations.length);
    return im.stateSchema.parse({
        ...builtOf(run),
        started: true,
        impostors,
        tasks: Object.fromEntries(
            names.map((name) => [name, im.tasksFor(run.id, name, layout, count)])
        ),
        done: {},
        ready: Object.fromEntries(
            impostors.map((name) => [name, now + options.killCooldown * 1000])
        ),
        calmUntil: now + im.EMERGENCY_CALM_MS
    });
}

function seatOf(run: stored.EventRun, name: string): arena.Spot {
    const index = Math.max(
        0,
        run.entrants.findIndex((one) => lower(one.name) === lower(name))
    );
    return im.seatSpot(layoutOf(run), index, run.entrants.length);
}

function taskOf(layout: im.Layout, id: number): said.Task {
    const station = layout.stations[id]!;
    return {
        room: layout.rooms[station.room]!.name as im.RoomName,
        kind: station.kind
    };
}

/** Every minimap radar off for one player, and why. */
function radarOff(name: string): string {
    return radarLine(name, RADAR_OFF, said.radarOff);
}

async function goLines(ctx: KindContext): Promise<string[]> {
    const run = ctx.run;
    const language = ctx.language;
    const options = optionsOf(run);
    const layout = layoutOf(run);
    const state = firstState(run, ctx.now);
    const era = state.era;
    const memory = memoryOf(run.id);
    // No hit from before "Go!" - or from another arena's fight - read as a kill.
    const out: string[] = [...hits.TAGS_OFF, im.LABELS_OFF];
    for (const station of layout.stations)
        out.push(
            im.labelLine(
                station,
                layout.box.y1 + (station.kind === "scan" ? 1.6 : 2.6),
                said.taskName(taskOf(layout, station.id), ctx.home),
                era
            )
        );
    for (const one of run.entrants) {
        const impostor = im.isImpostor(state, one.name);
        memory.seen.add(lower(one.name));
        const tasks = (state.tasks[one.name] ?? []).map((id) => taskOf(layout, id));
        out.push(
            ...im.startLines(one.name, impostor),
            arena.moveTo(one.name, seatOf(run, one.name)),
            radarOff(one.name),
            ...arena.titleTo(
                one.name,
                impostor ? imMessages.impostorTitle(language) : imMessages.crewTitle(language),
                impostor
                    ? imMessages.impostorSubtitle(language)
                    : imMessages.crewSubtitle(state.impostors.length, language)
            ),
            arena.tellTo(
                one.name,
                messages.tag(language) + imMessages.taskList(tasks, impostor, language)
            )
        );
        const others = state.impostors.filter((name) => lower(name) !== lower(one.name));
        if (impostor && others.length > 0)
            out.push(
                arena.tellTo(
                    one.name,
                    messages.tag(language) + imMessages.partners(others, language)
                )
            );
    }
    out.push(
        commands.say(messages.tag(language) + imMessages.howTo(options.killCooldown, language))
    );
    ctx.run = {
        ...ctx.run,
        game: state,
        points: Object.fromEntries(
            im.scoresOf(
                state,
                run.entrants.map((one) => one.name)
            )
        )
    };
    return out;
}

/** Everybody alive to their seat, the bodies taken away, the meeting open. */
function callMeeting(
    ctx: KindContext,
    state: im.ImpostorState,
    lines: string[],
    reason: "report" | "emergency",
    by: string,
    body: string | null
): void {
    const run = ctx.run;
    const options = optionsOf(run);
    const now = ctx.now;
    const voteAt = now + options.discussionSeconds * 1000;
    state.meeting = {
        reason,
        by,
        body,
        startedAt: now,
        voteAt,
        endsAt: voteAt + options.votingSeconds * 1000,
        ballots: false,
        votes: {}
    };
    state.meetings += 1;
    if (reason === "emergency") state.called[by] = (state.called[by] ?? 0) + 1;
    for (const one of state.bodies) one.gone = true;
    const memory = memoryOf(run.id);
    memory.scanning.clear();
    const language = ctx.language;
    lines.push(...im.BODIES_OFF);
    for (const one of run.entrants)
        if (!im.isDead(state, one.name)) lines.push(arena.moveTo(one.name, seatOf(run, one.name)));
    lines.push(
        ...arena.titleTo(
            `@a[tag=${arena.IN_ARENA}]`,
            reason === "report"
                ? imMessages.reportedTitle(language)
                : imMessages.emergencyTitle(language),
            imMessages.meetingSubtitle(by, language)
        ),
        commands.say(
            messages.tag(language) +
                (reason === "report"
                    ? imMessages.reported(by, body ?? "?", language)
                    : imMessages.emergency(by, language))
        ),
        commands.say(
            messages.tag(language) + imMessages.discuss(options.discussionSeconds, language)
        ),
        commands.sound(commands.SOUNDS.start)
    );
}

/** The ballot, to one voter: who can be voted for, and a skip. */
function ballotLines(
    run: stored.EventRun,
    voter: string,
    alive: readonly string[],
    seconds: number,
    language: speech.Speech
): string[] {
    const candidates = run.entrants
        .map((one, index) => ({ name: one.name, index }))
        .filter((one) => alive.some((name) => lower(name) === lower(one.name)));
    const out: string[] = [];
    for (let at = 0; at < candidates.length; at += im.BALLOT_PER_LINE) {
        const chunk = candidates.slice(at, at + im.BALLOT_PER_LINE);
        out.push(
            im.buttonsLine(
                voter,
                at === 0 ? messages.tag(language) + imMessages.ballotLead(seconds, language) : "",
                chunk.map((one) => ({
                    label: one.name,
                    color: "yellow",
                    value: im.VOTE_BASE + one.index
                }))
            )
        );
    }
    out.push(
        im.buttonsLine(voter, "", [
            { label: imMessages.skipLabel(language), color: "gray", value: im.PRESSED_SKIP }
        ])
    );
    return out;
}

/** Out of the game, how they went: dead, a body left; voted out; gone. */
function putOut(
    ctx: KindContext,
    state: im.ImpostorState,
    lines: string[],
    name: string,
    how: "killed" | "voted" | "left",
    by: string | null
): void {
    state.dead.push({ name, at: ctx.now, how, by });
    memoryOf(ctx.run.id).scanning.delete(lower(name));
    lines.push(...im.ghostLines(name), ...hits.tagsOff(name));
    if (how === "left") return;
    lines.push(arena.tellTo(name, messages.tag(ctx.language) + imMessages.ghostTip(ctx.language)));
}

async function tick(ctx: KindContext, lines: string[]): Promise<string | null> {
    const run = ctx.run;
    const language = ctx.language;
    const options = optionsOf(run);
    const { layout, plan } = stationOf(run);
    const box = run.arena!.box;
    const now = ctx.now;
    const memory = memoryOf(run.id);
    const say = (line: string) => ctx.server.say([line]);
    const names = run.entrants.map((one) => one.name);
    const here = new Map(
        commands.readWhere(await say(commands.IN_OVERWORLD)).map((one) => [lower(one.name), one])
    );
    const on = new Set(here.keys());
    // Who struck and who was hurt since the last look: the pack's, or else what
    // the damage counts say - nothing on the first look after a restart.
    const taken = await hitsService.take(ctx);
    const struck =
        taken?.struck ??
        hits.roseFor(memory.dealt, commands.readScores(await say(im.READ_DEALT)), on);
    const hurt =
        taken?.hurt ??
        hits.roseFor(memory.taken, commands.readScores(await say(im.READ_TAKEN)), on);
    // What was pressed since the last look, each set back to nothing at once.
    const presses = [...commands.readScores(await say(im.READ_PRESS)).entries()].filter(
        ([, value]) => value > 0
    );
    if (presses.length > 0) await ctx.server.sayAll(presses.map(([name]) => im.resetPress(name)));
    const chat = (await ctx.chat()) ?? [];

    const before = im.stateOf(run.game);
    const state: im.ImpostorState = structuredClone(
        before?.started ? before : firstState(run, run.readyAt ?? now)
    );
    const entrant = (name: string) => names.find((one) => lower(one) === lower(name)) ?? null;
    const alive = () => im.aliveOf(state, names);
    const isAlive = (name: string) => !im.isDead(state, name);
    const tell = (name: string, line: string) =>
        lines.push(arena.tellTo(name, messages.tag(language) + line));

    // Back on the server: the radar off again, and a ghost back to watching.
    for (const name of names) {
        if (!on.has(lower(name)) || memory.seen.has(lower(name))) continue;
        lines.push(radarOff(name));
        if (!isAlive(name)) lines.push(...im.ghostLines(name));
    }
    memory.seen = on;

    // Gone from the server for a while: out, or the game would wait on them.
    for (const name of alive()) {
        if (on.has(lower(name))) {
            memory.missing.delete(lower(name));
            continue;
        }
        const since = memory.missing.get(lower(name)) ?? now;
        memory.missing.set(lower(name), since);
        if (now - since < im.MISSING_MS) continue;
        putOut(ctx, state, lines, name, "left", null);
        lines.push(commands.say(messages.tag(language) + imMessages.leftGame(name, language)));
        if (state.meeting) delete state.meeting.votes[name];
    }

    if (state.meeting) await meetingTick(ctx, state, lines, presses, chat);
    else {
        // Kills: a crew member hurt by an impostor whose kill was ready.
        const strikers = alive()
            .filter(
                (name) =>
                    im.canKill(state, name, now) && struck.has(lower(name)) && here.has(lower(name))
            )
            .map((name) => ({ ...here.get(lower(name))!, name }));
        const hurtCrew = alive().filter(
            (name) => !im.isImpostor(state, name) && hurt.has(lower(name)) && here.has(lower(name))
        );
        const attackers =
            strikers.length > 0 && hurtCrew.length > 0
                ? await hitsService.attackers(ctx, hurtCrew)
                : new Map<string, string | null>();
        for (const victim of hurtCrew) {
            const at = here.get(lower(victim))!;
            const killer = im.killerOf(
                at,
                strikers.filter((one) => im.canKill(state, one.name, now)),
                attackers.get(lower(victim))
            );
            if (!killer) continue;
            putOut(ctx, state, lines, victim, "killed", killer);
            state.kills[killer] = (state.kills[killer] ?? 0) + 1;
            state.ready[killer] = now + options.killCooldown * 1000;
            const body: im.Body = {
                name: victim,
                x: at.x,
                y: Math.floor(at.y),
                z: at.z,
                gone: false
            };
            state.bodies.push(body);
            lines.push(
                ...im.bodyLines(body, state.bodies.length - 1, state.era),
                ...arena.titleTo(
                    victim,
                    imMessages.killedTitle(language),
                    imMessages.killedSubtitle(language)
                ),
                arena.actionbarTo(killer, imMessages.killedLine(language)),
                `execute in minecraft:overworld positioned ${at.x.toFixed(1)} ${at.y.toFixed(1)} ${at.z.toFixed(1)} run playsound minecraft:entity.player.hurt master @a[distance=..8] ~ ~ ~ 1 0.8`
            );
        }

        // Vents: an impostor on one comes out of its pair.
        for (const name of alive()) {
            if (!im.isImpostor(state, name)) continue;
            const at = here.get(lower(name));
            if (!at) continue;
            const under = im.ventUnder(layout, at);
            if (!under) continue;
            if (now - (memory.vented.get(lower(name)) ?? 0) < im.VENT_PAUSE_MS) continue;
            memory.vented.set(lower(name), now);
            const to = layout.vents[under.vent.to]!;
            lines.push(
                arena.moveTo(name, im.ventExit(layout, to)),
                `execute as ${name} at @s run playsound minecraft:block.iron_trapdoor.close master @s ~ ~ ~ 0.6 1`
            );
        }

        // Presses: a task, the emergency button, a body.
        let called: { reason: "report" | "emergency"; by: string; body: string | null } | null =
            null;
        const reportBody = (by: string, index: number) => {
            const body = state.bodies[index];
            if (!body || body.gone || called) return;
            called = { reason: "report", by, body: body.name };
        };
        for (const [who, value] of presses) {
            const name = entrant(who);
            const press = im.pressOf(value);
            if (!name || !press || !isAlive(name)) continue;
            if (press.kind === "task") completeTask(ctx, state, lines, name, press.station);
            else if (press.kind === "report") reportBody(name, press.body);
            else if (press.kind === "emergency" && !called) {
                if (now < state.calmUntil)
                    tell(name, imMessages.emergencyWait((state.calmUntil - now) / 1000, language));
                else if ((state.called[name] ?? 0) >= options.emergencies)
                    tell(name, imMessages.noEmergencyLeft(language));
                else called = { reason: "emergency", by: name, body: null };
            }
        }
        // `report` typed beside a body.
        for (const line of chat) {
            const name = entrant(line.name);
            if (!name || !isAlive(name) || !im.reportSaid(line.text)) continue;
            const at = here.get(lower(name));
            if (!at) continue;
            const index = nearestBody(state, at);
            if (index !== null) reportBody(name, index);
        }

        // Plates: stood on for `SCAN_SECONDS`, by the crew member they belong to.
        for (const name of alive()) {
            const at = here.get(lower(name));
            const scan = at
                ? layout.stations.find((one) => one.kind === "scan" && im.standsOn(layout, at, one))
                : undefined;
            if (!scan) {
                memory.scanning.delete(lower(name));
                continue;
            }
            const was = memory.scanning.get(lower(name));
            const since = was && was.station === scan.id ? was.since : now;
            memory.scanning.set(lower(name), { station: scan.id, since });
            const seconds = (now - since) / 1000;
            if (im.isImpostor(state, name) || !owes(state, name, scan.id)) continue;
            if (seconds >= im.SCAN_SECONDS) {
                completeTask(ctx, state, lines, name, scan.id);
                memory.scanning.delete(lower(name));
            } else
                lines.push(
                    arena.actionbarTo(name, imMessages.scanBar(seconds, im.SCAN_SECONDS, language))
                );
        }

        // A body nobody has reported: whoever comes by it is shown the button.
        for (const name of alive()) {
            const at = here.get(lower(name));
            if (!at) continue;
            const index = nearestBody(state, at);
            if (index === null || memory.told.has(`${lower(name)}:${index}`)) continue;
            memory.told.add(`${lower(name)}:${index}`);
            lines.push(
                im.buttonsLine(name, messages.tag(language) + imMessages.nearBody(language), [
                    {
                        label: imMessages.reportLabel(language),
                        color: "red",
                        value: im.REPORT_BASE + index
                    }
                ])
            );
        }

        const call = called as {
            reason: "report" | "emergency";
            by: string;
            body: string | null;
        } | null;
        if (call && !im.verdict(state, names))
            callMeeting(ctx, state, lines, call.reason, call.by, call.body);
    }

    // Decided: by the game, or by the time running out on the impostors.
    let decided: string | null = null;
    const found = im.verdict(state, names);
    const timeUp = run.endsAt - now <= ctx.tickSeconds * 1000;
    if (found || timeUp) {
        const ending = found ?? { winner: "impostors" as const, why: "time" as const };
        state.winner = ending.winner;
        state.why = ending.why;
        state.meeting = null;
        lines.push(
            commands.say(
                messages.tag(language) +
                    (ending.winner === "crew"
                        ? imMessages.crewWon(ending.why as "tasks" | "voted", language)
                        : imMessages.impostorsWon(ending.why as "outnumbered" | "time", language))
            ),
            commands.say(
                messages.tag(language) + imMessages.impostorsWere(state.impostors, language)
            ),
            commands.sound(commands.SOUNDS.win)
        );
        decided =
            ending.why === "tasks"
                ? said.CREW_TASKS
                : ending.why === "voted"
                  ? said.CREW_VOTED
                  : ending.why === "outnumbered"
                    ? said.IMPOSTORS_OUTNUMBERED
                    : said.IMPOSTORS_TIME;
    }

    // Nobody hurt; nobody but an impostor whose kill is ready able to hurt;
    // everybody in the station, the living on their screen told how it goes.
    const progress = im.progressOf(state, names);
    const meeting = state.meeting;
    for (const name of names) {
        const at = here.get(lower(name));
        if (!at) continue;
        if (!isAlive(name)) {
            if (!arena.contains(box, at)) lines.push(arena.moveTo(name, seatOf(run, name)));
            lines.push(arena.actionbarTo(name, imMessages.ghostBar(language)));
            continue;
        }
        lines.push(...im.unhurtLines(name));
        const armed = im.canKill(state, name, now) && decided === null;
        lines.push(armed ? im.armedLine(name) : im.weakLine(name));
        if (meeting) {
            const seat = seatOf(run, name);
            if (Math.hypot(at.x - (seat.x + 0.5), at.z - (seat.z + 0.5)) > 1.5)
                lines.push(arena.moveTo(name, seat));
            const voting = now >= meeting.voteAt;
            lines.push(
                arena.actionbarTo(
                    name,
                    imMessages.meetingBar(
                        voting,
                        ((voting ? meeting.endsAt : meeting.voteAt) - now) / 1000,
                        language
                    )
                )
            );
            continue;
        }
        if (!im.inside(layout, at, plan)) lines.push(arena.moveTo(name, seatOf(run, name)));
        if (memory.scanning.has(lower(name)) && !im.isImpostor(state, name)) continue;
        if (im.isImpostor(state, name))
            lines.push(
                arena.actionbarTo(
                    name,
                    imMessages.impostorBar(((state.ready[name] ?? 0) - now) / 1000, language)
                )
            );
        else {
            const mine = state.tasks[name] ?? [];
            const done = state.done[name] ?? [];
            const next = mine.find((id) => !done.includes(id));
            lines.push(
                arena.actionbarTo(
                    name,
                    imMessages.crewBar(
                        done.length,
                        mine.length,
                        next === undefined ? null : taskOf(layout, next),
                        language
                    )
                )
            );
        }
    }
    lines.push(
        im.ENABLE_PRESS,
        `bossbar set ${commands.BAR} name ${commands.text(
            imMessages.bar(
                progress.done,
                progress.total,
                messages.clock((run.endsAt - now) / 1000),
                language
            )
        )}`,
        ...arena.keepThrown(box),
        ...(run.marker ? [arena.killBrokenDrops(box, run.marker)] : [])
    );
    if (JSON.stringify(state) !== JSON.stringify(before)) {
        const scores = im.scoresOf(state, names);
        ctx.run = { ...ctx.run, game: state, points: Object.fromEntries(scores) };
        await ctx.persist();
    }
    return decided;
}

/** Whether a crew member still has this station to do. */
function owes(state: im.ImpostorState, name: string, station: number): boolean {
    return (
        (state.tasks[name] ?? []).includes(station) && !(state.done[name] ?? []).includes(station)
    );
}

/** A station worked by `name`: one of their tasks done, if it was one. An
 *  impostor's, or one not on their list, counts nothing. */
function completeTask(
    ctx: KindContext,
    state: im.ImpostorState,
    lines: string[],
    name: string,
    station: number
): void {
    if (im.isImpostor(state, name) || !owes(state, name, station)) return;
    const done = [...(state.done[name] ?? []), station];
    state.done[name] = done;
    const total = (state.tasks[name] ?? []).length;
    const language = ctx.language;
    lines.push(
        arena.tellTo(
            name,
            messages.tag(language) +
                imMessages.taskDone(
                    taskOf(layoutOf(ctx.run), station),
                    done.length,
                    total,
                    language
                )
        ),
        `execute as ${name} at @s run playsound minecraft:block.note_block.chime master @s ~ ~ ~ 1 1.4`
    );
    if (done.length >= total)
        lines.push(arena.tellTo(name, messages.tag(language) + imMessages.allTasksDone(language)));
}

/** The body nobody has reported nearest to somebody, within reach of it. */
function nearestBody(
    state: im.ImpostorState,
    at: { x: number; y: number; z: number }
): number | null {
    let best: number | null = null;
    let nearest = im.REPORT_REACH;
    for (const [index, body] of state.bodies.entries()) {
        if (body.gone) continue;
        const away = Math.hypot(body.x - at.x, body.z - at.z);
        if (away <= nearest && Math.abs(body.y - at.y) < 2) {
            nearest = away;
            best = index;
        }
    }
    return best;
}

/** One look in a meeting: the ballots once the talking is over, the votes
 *  taken, and the result once they are all in or the time is up. */
async function meetingTick(
    ctx: KindContext,
    state: im.ImpostorState,
    lines: string[],
    presses: readonly [string, number][],
    chat: readonly { name: string; text: string }[]
): Promise<void> {
    const run = ctx.run;
    const meeting = state.meeting!;
    const now = ctx.now;
    const language = ctx.language;
    const options = optionsOf(run);
    const names = run.entrants.map((one) => one.name);
    const alive = im.aliveOf(state, names);
    const entrant = (name: string) => alive.find((one) => lower(one) === lower(name)) ?? null;
    if (now < meeting.voteAt) return;
    if (!meeting.ballots) {
        meeting.ballots = true;
        const seconds = Math.max(1, Math.round((meeting.endsAt - now) / 1000));
        for (const voter of alive) lines.push(...ballotLines(run, voter, alive, seconds, language));
    }
    const vote = (voter: string, target: string) => {
        if (meeting.votes[voter] !== undefined) return;
        meeting.votes[voter] = target;
        const left = alive.filter((one) => meeting.votes[one] === undefined).length;
        lines.push(commands.say(messages.tag(language) + imMessages.voted(voter, left, language)));
    };
    for (const [who, value] of presses) {
        const voter = entrant(who);
        const press = im.pressOf(value);
        if (!voter || !press) continue;
        if (press.kind === "skip") vote(voter, im.SKIP);
        if (press.kind === "vote") {
            const target = run.entrants[press.entrant]?.name;
            if (target && entrant(target)) vote(voter, entrant(target)!);
        }
    }
    for (const line of chat) {
        const voter = entrant(line.name);
        const target = voter ? im.voteSaid(line.text, alive) : null;
        if (voter && target) vote(voter, target);
    }
    const allIn = alive.every((one) => meeting.votes[one] !== undefined);
    if (!allIn && now < meeting.endsAt) return;
    const outcome = im.voteOutcome(meeting.votes, alive);
    if (outcome.out) {
        const out = outcome.out;
        putOut(ctx, state, lines, out, "voted", null);
        lines.push(
            ...arena.titleTo(out, imMessages.ejectedTitle(language), ""),
            commands.say(
                messages.tag(language) +
                    imMessages.ejected(
                        out,
                        options.confirmEjects ? im.isImpostor(state, out) : null,
                        language
                    )
            )
        );
    } else
        lines.push(
            commands.say(
                messages.tag(language) + imMessages.nobodyEjected(outcome.skipped, language)
            )
        );
    state.meeting = null;
    state.calmUntil = now + im.EMERGENCY_CALM_MS;
    for (const name of state.impostors) state.ready[name] = now + options.killCooldown * 1000;
}

/** What the server can show, asked once before the station is built. */
async function prepare(ctx: KindContext): Promise<Record<string, unknown>> {
    const era: im.Era = {
        interaction: await ctx.atLeast([1, 19, 4]),
        components: await ctx.atLeast([1, 20, 5]),
        itemCommand: await ctx.atLeast([1, 17]),
        modernText: await ctx.atLeast([1, 21, 5])
    };
    return { design: im.DESIGN, era, rows: im.rowsFor(ctx.run.joined.length) };
}

export const impostor: ArenaGame = {
    most: () => im.MOST,
    reach: (run) => im.reachOf(run.joined.length),
    box: (run, place) => im.stationBox(place, place.y + arena.ALTITUDE, run.joined.length),
    prepare,
    built: (run) => ({
        design: builtOf(run).design ?? im.DESIGN,
        era: eraOf(run),
        rows: run.arena ? im.rowsOf(run.arena.box) : im.rowsFor(run.joined.length)
    }),
    fills: (run, box) => im.stationFills(im.layoutFor(run.id, box)),
    blocks: () => im.stationBlocks(),
    kit: () => [],
    hits: true,
    side: (_run, index) => index,
    spot: (run, entrant) => seatOf(run, entrant.name),
    beginLines: () => im.setupLines(),
    goLines,
    tick,
    // The switches, the buttons and the bodies read between the looks too: a
    // button is down for a second, and the look comes round every one.
    quickLines: (run) => {
        const state = im.stateOf(run.game);
        if (!state?.started || state.winner) return [];
        return [
            ...im.pressLines(layoutOf(run)),
            ...im.reportLines(state.bodies, state.era),
            ...(run.marker ? [arena.killBrokenDrops(run.arena!.box, run.marker)] : [])
        ];
    },
    results: (run) =>
        im.scoresOf(
            im.stateOf(run.game),
            run.entrants.map((one) => one.name)
        ),
    resultLines: (run, language) => {
        const state = im.stateOf(run.game);
        if (!state?.winner) return [];
        return [
            commands.say(
                state.winner === "crew"
                    ? imMessages.crewWon(state.why === "tasks" ? "tasks" : "voted", language)
                    : imMessages.impostorsWon(
                          state.why === "time" ? "time" : "outnumbered",
                          language
                      )
            ),
            commands.say(imMessages.impostorsWere(state.impostors, language))
        ];
    },
    endLines: (run) => [
        ...im.entitiesOff(),
        ...im.TEARDOWN,
        ...run.entrants.map((one) => radarLine(one.name, RADAR_RESET))
    ],
    // Nothing lying about once the station is coming down, for a run that
    // never reached its end too.
    closeLines: () => im.entitiesOff(),
    owedLines: (_run, name) => [{ reason: "radar", lines: [radarLine(name, RADAR_RESET)] }]
};
