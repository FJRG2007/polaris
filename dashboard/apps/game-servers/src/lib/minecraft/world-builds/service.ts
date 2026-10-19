/**
 * Seasonal builds placed in a server's world while its season is on, and taken
 * down when it ends (`plan.ts` says where and how).
 *
 * Driven by the season sweep (`seasonal-service.ts`), with the same switches:
 * a server or deployment switched off is a season that is over. One build is
 * worked on per server per pass, a few paste chunks at a time, and what is up
 * is written in the install's config before its first block goes in - so a
 * restart half way goes on where it stopped, nothing is pasted twice, and
 * whatever is in the world can always be taken down again.
 */

import * as plan from "./plan";
import { createHash } from "node:crypto";
import { host } from "@polaris/app-host";
import { WORLD_BUILDS } from "./catalog";
import type { Box } from "../events/state";
import type { PolarisBuild } from "./format";
import type { Decoration } from "../seasonal";
import * as commands from "../events/commands";
import * as arena from "../events/kinds/arena";
import * as chunks from "../events/kinds/chunks";
import type { ServerContainer } from "../service";
import { build, cancelBatch, capabilities } from "../events/in-server";

/** Sites surveyed for one build in one pass: each costs a handful of trips. */
const SITES_PER_PASS = 6;
/** Paste chunks run for one build in one pass; the rest go in on the next. */
const CHUNKS_PER_PASS = 8;
/** On a server without the Polaris jar every command is its own: one chunk a
 *  pass, sent a few at a time with a pause between, so the server keeps up. */
const PLAIN_CHUNKS_PER_PASS = 1;
const PLAIN_LINES_PER_TRIP = 64;
const PLAIN_PAUSE_MS = 250;

/** The survey's own markers: unmarked, so an event's survey or mark on the same
 *  server at the same moment neither reads nor clears them. */
const SAMPLE_TAG = "pw_samp";

/** Servers whose builds are being worked on: a pass never overlaps the last. */
const busy = new Set<string>();

const LOG = "[minecraft-seasonal]";

/** The batch key a build is pasted and cancelled under: the same across restarts. */
function batchKeyFor(installedAppId: string, id: string): string {
    return `pw${createHash("sha256").update(`${installedAppId}:${id}`).digest("hex").slice(0, 24)}`;
}

async function writePlaced(
    installedAppId: string,
    change: (list: plan.Placed[]) => plan.Placed[]
): Promise<void> {
    await host.appsInstallConfig.patchInstallConfig(installedAppId, (config) => ({
        [plan.WORLD_BUILDS_KEY]: [...change(plan.readPlaced(config)), ...plan.unreadPlaced(config)]
    }));
}

const same = (one: plan.Placed, other: plan.Placed) =>
    one.id === other.id && one.season === other.season;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `lines` sent the way a server without the jar keeps up with: a few at a time. */
async function paced(server: ServerContainer, lines: readonly string[]): Promise<void> {
    for (let at = 0; at < lines.length; at += PLAIN_LINES_PER_TRIP) {
        if (at > 0) await pause(PLAIN_PAUSE_MS);
        await server.sayAll(lines.slice(at, at + PLAIN_LINES_PER_TRIP));
    }
}

/** `lines` run in chunks, each through the jar's batch or paced: false once one did not finish. */
async function runChunks(
    server: ServerContainer,
    chunks: readonly (readonly string[])[],
    key?: string
): Promise<boolean> {
    for (const chunk of chunks) {
        if (!(await build(server, chunk, (lines) => paced(server, lines), undefined, key)))
            return false;
    }
    return true;
}

/** Run `work` with the box's chunks held loaded, and let them go after - all
 *  but the ones somebody held before, a farm's, which stay loaded. Null, with
 *  nothing run, when those could not be read: left for a later pass. */
async function loaded<T>(
    server: ServerContainer,
    box: Box,
    work: () => Promise<T>
): Promise<T | null> {
    const held = chunks.readForced(await server.say([chunks.READ_FORCED]).catch(() => ""));
    if (!held) return null;
    await server.sayAll([arena.forceloadArea(box, true)]);
    try {
        return await work();
    } finally {
        await server.sayAll(chunks.spareHeld(arena.forceloadArea(box, false), held));
    }
}

/** Where players live in the overworld - where they stand only when nobody
 *  has a bed - in the same order every pass: what a build goes near. */
async function homesOf(server: ServerContainer): Promise<{ x: number; z: number }[]> {
    const [spawnX, spawnZ, respawn, spawnWorld, respawnWorld] = await Promise.all(
        commands.HOMES.map((line) => server.say([line]).catch(() => ""))
    );
    const beds = commands.readHomes(
        spawnX ?? "",
        spawnZ ?? "",
        respawn ?? "",
        spawnWorld ?? "",
        respawnWorld ?? ""
    );
    if (beds.length > 0) return plan.stableHomes(beds, []);
    const standing = commands.readWhere(
        await server
            .say(["execute in minecraft:overworld as @a[distance=0..] run data get entity @s Pos"])
            .catch(() => "")
    );
    return plan.stableHomes([], standing);
}

/** The searches the config holds, but only for `season`'s builds. */
function searchesOf(
    config: Readonly<Record<string, unknown>>,
    season: readonly PolarisBuild[]
): Record<string, plan.SiteSearch> {
    return Object.fromEntries(
        Object.entries(plan.readSiteSearches(config)).filter(([id]) =>
            season.some((one) => one.id === id)
        )
    );
}

/** Write where a build's search stands, or forget it (`null`). */
async function writeSearch(
    installedAppId: string,
    id: string,
    search: plan.SiteSearch | null,
    season: readonly PolarisBuild[]
): Promise<void> {
    await host.appsInstallConfig.patchInstallConfig(installedAppId, (config) => {
        const kept = searchesOf(config, season);
        delete kept[id];
        return { [plan.SITE_SEARCH_KEY]: search ? { ...kept, [id]: search } : kept };
    });
}

/** The markers every one of `linesFor`'s lines answers - each line names what
 *  is the world's, and a marker on anything else is in all of them - tried
 *  with the newest list of names first; Infinity when the server would not say. */
async function unnatural(
    server: ServerContainer,
    linesFor: (names: commands.GroundNames) => string[]
): Promise<number> {
    for (const names of commands.GROUND_NAMES) {
        const answers: Set<string>[] = [];
        let refused = false;
        for (const line of linesFor(names)) {
            const output = await server.say([line]);
            if (commands.nameRefused(output)) {
                refused = true;
                break;
            }
            const found = new Set(commands.samplesIn(output).map((one) => `${one.x},${one.z}`));
            answers.push(found);
            if (found.size === 0) break;
        }
        if (refused) continue;
        const [first, ...rest] = answers;
        return [...(first ?? [])].filter((one) => rest.every((set) => set.has(one))).length;
    }
    return Number.POSITIVE_INFINITY;
}

type SiteAnswer =
    | { readonly origin: plan.Point; readonly foundation: plan.FoundationRun[] }
    | { readonly why: string };

/** Whether a box holds nothing but air. */
async function allAir(server: ServerContainer, box: Box): Promise<boolean> {
    for (const piece of arena.slices(box)) {
        if (arena.readCount(await server.say([arena.solidCount(piece)])) !== 0) return false;
    }
    return true;
}

/**
 * Whether the build fits at `center`: the origin it would take and the
 * foundation under it, or why not. Every column of the footprint is read, a
 * strip at a time, so no answer is longer than RCON hands back; the cheapest
 * reasons are asked first, and the rest only of a site still in the running.
 */
async function surveySite(
    server: ServerContainer,
    wanted: PolarisBuild,
    center: { x: number; z: number }
): Promise<SiteAnswer> {
    const columns = plan.footprintOf(wanted, center);
    const strips = plan.stripsOf(wanted, center).map((strip) => plan.stripTag(SAMPLE_TAG, strip));
    try {
        await server.sayAll(commands.topLines(columns, SAMPLE_TAG, false));
        const inside = new Set(columns.map((one) => `${one.x},${one.z}`));
        const read = new Map<string, plan.Point>();
        for (const tag of strips) {
            for (const one of commands.samplesIn(await server.say([commands.readSamples(tag)]))) {
                const key = `${one.x},${one.z}`;
                if (inside.has(key)) read.set(key, one);
            }
        }
        const tops = [...read.values()];
        const verdict = plan.judgeSite(columns.length, tops, 0, wanted);
        if (!("y" in verdict)) return verdict;
        // Off any build, tree, water or lava, in every column.
        for (const tag of strips) {
            let covered = await unnatural(server, (names) =>
                commands.builtUnderSamples(names, tag)
            );
            for (const block of [...commands.TREE_BLOCKS, "minecraft:water", "minecraft:lava"])
                covered += commands.samplesIn(
                    await server.say([commands.samplesOn(block, tag)])
                ).length;
            if (covered > 0) return { why: "covered" };
        }
        // Over the ground, only air or what grows there: nobody's rail or torch
        // goes under the foundation.
        for (const tag of strips) {
            for (let dy = 0; dy < plan.LIFT_MAX; dy += 1) {
                const stray = await unnatural(server, (names) =>
                    commands.strayAtSamples(names, dy, tag)
                );
                if (stray > 0) return { why: "occupied" };
            }
        }
        // Its whole box nothing but air - lifted over the grass in its way - or
        // it is not built on.
        for (let lift = 0; lift <= plan.LIFT_MAX; lift += 1) {
            const origin = plan.originFor(wanted, center, verdict.y + lift);
            if (await allAir(server, plan.boxFor(wanted, origin)))
                return { origin, foundation: plan.foundationRuns(tops, origin.y) };
        }
        return { why: "not-air" };
    } finally {
        await server.sayAll([commands.clearSamples(SAMPLE_TAG)]);
    }
}

/**
 * A site for `wanted` near the players: its origin, or null when none of this
 * pass's will do. Each pass goes on round the rings where the last one stopped -
 * written in the config, so a restart does too - and a home whose nearest
 * ground is all built on still gets a site further out. A new list (somebody
 * with a bed came or went) goes on after the last site surveyed when that is
 * still in it, and from its nearest otherwise.
 */
async function findSite(
    server: ServerContainer,
    wanted: PolarisBuild,
    config: Readonly<Record<string, unknown>>,
    season: readonly PolarisBuild[]
): Promise<{ origin: plan.Point; foundation: plan.FoundationRun[] } | null> {
    const centers = plan.candidateCenters(await homesOf(server), wanted, Number.POSITIVE_INFINITY);
    if (centers.length === 0) return null;
    const list = plan.listDigest(centers);
    const stored = plan.readSiteSearches(config)[wanted.id];
    const from = plan.searchStart(stored, centers);
    let next = from;
    for (const center of centers.slice(from, from + SITES_PER_PASS)) {
        const reach = plan.radiusOf(wanted) + 1;
        const area = {
            x1: center.x - reach,
            y1: 0,
            z1: center.z - reach,
            x2: center.x + reach,
            y2: 0,
            z2: center.z + reach
        };
        const answer = await loaded(server, area, () => surveySite(server, wanted, center));
        const where = `${server.installedAppId}: ${wanted.id} site ${next + 1}/${centers.length} at ${center.x},${center.z}`;
        // The server would not say which chunks were held: this site again next pass.
        if (!answer) {
            console.info(`${LOG} ${where}: chunks unreadable`);
            break;
        }
        next += 1;
        if ("origin" in answer) {
            const { x, y, z } = answer.origin;
            const blocks = plan
                .foundationPieces(answer.foundation)
                .reduce((sum, piece) => sum + piece.blocks, 0);
            const under = blocks > 0 ? `, foundation of ${blocks} blocks` : "";
            console.info(`${LOG} ${where}: site, origin ${x} ${y} ${z}${under}`);
            if (stored) await writeSearch(server.installedAppId, wanted.id, null, season);
            return answer;
        }
        console.info(`${LOG} ${where}: ${answer.why}`);
    }
    // Nothing surveyed - the server would not say - is nothing to write down.
    if (next === from) return null;
    const last = centers[next - 1]!;
    const search = { list, next: next >= centers.length ? 0 : next, last };
    await writeSearch(server.installedAppId, wanted.id, search, season);
    return null;
}

/** Paste what is left of a build, a few chunks a pass. */
async function paste(
    server: ServerContainer,
    wanted: PolarisBuild,
    placed: plan.Placed
): Promise<void> {
    const box = placed.arena.box;
    const chunks = plan.pasteChunks(plan.piecesOf(wanted, placed));
    const key = placed.arena.batch ?? batchKeyFor(server.installedAppId, wanted.id);
    // One this process stopped waiting for - restarted half way - is called off first.
    await cancelBatch(server, key);
    const perPass = (await capabilities(server)).has("batch")
        ? CHUNKS_PER_PASS
        : PLAIN_CHUNKS_PER_PASS;
    await loaded(server, box, async () => {
        let done = placed.pasted;
        for (const chunk of chunks.slice(done, done + perPass)) {
            if (!(await runChunks(server, [chunk], key))) return;
            done += 1;
            const up = done >= chunks.length;
            const pasted = done;
            await writePlaced(server.installedAppId, (list) =>
                list.map((one) => (same(one, placed) ? { ...one, pasted, up } : one))
            );
        }
    });
}

/** A build taken down, and forgotten once it is. */
async function takeDown(
    server: ServerContainer,
    placed: plan.Placed,
    catalog: readonly PolarisBuild[]
): Promise<void> {
    if (placed.arena.batch) await cancelBatch(server, placed.arena.batch);
    const from = catalog.find((one) => one.id === placed.id && one.season === placed.season);
    const lines = plan.restoreLines(placed, from);
    const chunks = plan.pasteChunks(lines.map((line) => ({ line, blocks: 0 })));
    const gone = await loaded(server, placed.arena.box, () => runChunks(server, chunks));
    if (!gone) return;
    await writePlaced(server.installedAppId, (list) => list.filter((one) => !same(one, placed)));
}

/**
 * One pass for one running server: every build from another season - or from
 * one switched off - taken down, then the next of this season's builds put up.
 */
export async function reconcileWorldBuilds(
    server: ServerContainer,
    config: Readonly<Record<string, unknown>>,
    decoration: Decoration | null,
    catalog: readonly PolarisBuild[] = WORLD_BUILDS
): Promise<void> {
    if (busy.has(server.installedAppId)) return;
    busy.add(server.installedAppId);
    try {
        const placed = plan.readPlaced(config);
        for (const one of placed.filter((p) => p.season !== decoration))
            await takeDown(server, one, catalog);
        const season = decoration ? catalog.filter((one) => one.season === decoration) : [];
        // Searches for builds of a season that is over: nothing goes on from them.
        const searches = Object.keys(plan.readSiteSearches(config));
        if (searches.some((id) => !season.some((one) => one.id === id)))
            await host.appsInstallConfig.patchInstallConfig(server.installedAppId, (current) => ({
                [plan.SITE_SEARCH_KEY]: searchesOf(current, season)
            }));
        if (!decoration) return;
        for (const wanted of season) {
            const existing = placed.find(
                (one) => one.id === wanted.id && one.season === decoration
            );
            if (existing?.up) continue;
            let target = existing;
            if (!target) {
                const site = await findSite(server, wanted, config, season);
                if (!site) continue;
                const { origin } = site;
                const fresh = plan.placedFor(
                    wanted,
                    origin,
                    batchKeyFor(server.installedAppId, wanted.id),
                    site.foundation
                );
                await writePlaced(server.installedAppId, (list) => [
                    ...list.filter((one) => !same(one, fresh)),
                    fresh
                ]);
                target = fresh;
                console.info(
                    `${LOG} ${server.installedAppId}: placing ${wanted.id} at ${origin.x} ${origin.y} ${origin.z}`
                );
            }
            await paste(server, wanted, target);
            return;
        }
    } finally {
        busy.delete(server.installedAppId);
    }
}
