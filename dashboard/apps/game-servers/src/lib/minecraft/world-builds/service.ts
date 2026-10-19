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
import type { ServerContainer } from "../service";
import { build, cancelBatch } from "../events/in-server";

/** Sites surveyed for one build in one pass: each costs a handful of trips. */
const SITES_PER_PASS = 6;
/** Paste chunks run for one build in one pass; the rest go in on the next. */
const CHUNKS_PER_PASS = 8;

/** Servers whose builds are being worked on: a pass never overlaps the last. */
const busy = new Set<string>();

/** The batch key a build is pasted and cancelled under: the same across restarts. */
function batchKeyFor(installedAppId: string, id: string): string {
    return `pw${createHash("sha256").update(`${installedAppId}:${id}`).digest("hex").slice(0, 24)}`;
}

async function writePlaced(
    installedAppId: string,
    change: (list: plan.Placed[]) => plan.Placed[]
): Promise<void> {
    await host.appsInstallConfig.patchInstallConfig(installedAppId, (config) => ({
        [plan.WORLD_BUILDS_KEY]: change(plan.readPlaced(config))
    }));
}

const same = (one: plan.Placed, other: plan.Placed) =>
    one.id === other.id && one.season === other.season;

/** Run `work` with the box's chunks held loaded, and let them go after. */
async function loaded<T>(server: ServerContainer, box: Box, work: () => Promise<T>): Promise<T> {
    await server.sayAll([arena.forceloadArea(box, true)]);
    try {
        return await work();
    } finally {
        await server.sayAll([arena.forceloadArea(box, false)]);
    }
}

/** Where players live and stand in the overworld: what a build goes near. */
async function homesOf(server: ServerContainer): Promise<{ x: number; z: number }[]> {
    const [spawnX, spawnZ, respawn, spawnWorld, respawnWorld] = await Promise.all(
        commands.HOMES.map((line) => server.say([line]).catch(() => ""))
    );
    const standing = commands.readWhere(
        await server
            .say(["execute in minecraft:overworld as @a[distance=0..] run data get entity @s Pos"])
            .catch(() => "")
    );
    return [
        ...commands.readHomes(
            spawnX ?? "",
            spawnZ ?? "",
            respawn ?? "",
            spawnWorld ?? "",
            respawnWorld ?? ""
        ),
        ...standing.map((one) => ({ x: Math.floor(one.x), z: Math.floor(one.z) }))
    ];
}

/** Markers standing on something somebody built; Infinity when the server would not say. */
async function builtOn(server: ServerContainer): Promise<number> {
    for (const names of commands.GROUND_NAMES) {
        const answers: Set<string>[] = [];
        let refused = false;
        for (const line of commands.builtUnderSamples(names)) {
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

/** Whether the build fits at `center`: the origin it would take, or null. */
async function surveySite(
    server: ServerContainer,
    wanted: PolarisBuild,
    center: { x: number; z: number }
): Promise<plan.Point | null> {
    const columns = commands.footprintColumns(center, plan.radiusOf(wanted));
    try {
        await server.sayAll(commands.topLines(columns));
        const tops = commands.samplesIn(await server.say([commands.READ_SAMPLES]));
        let covered = await builtOn(server);
        for (const line of [
            ...commands.SAMPLES_ON_TREES,
            commands.SAMPLES_ON_WATER,
            commands.SAMPLES_ON_LAVA
        ])
            covered += commands.samplesIn(await server.say([line])).length;
        const verdict = plan.judgeSite(columns.length, tops, covered, wanted);
        if (!("y" in verdict)) return null;
        const origin = plan.originFor(wanted, center, verdict.y);
        // Its whole box nothing but air, or it is not built on.
        for (const piece of arena.slices(plan.boxFor(wanted, origin))) {
            if (arena.readCount(await server.say([arena.solidCount(piece)])) !== 0) return null;
        }
        return origin;
    } finally {
        await server.sayAll([commands.CLEAR_SAMPLES]);
    }
}

/** A site for `wanted` near the players: its origin, or null when none of the nearest will do. */
async function findSite(server: ServerContainer, wanted: PolarisBuild): Promise<plan.Point | null> {
    for (const center of plan.candidateCenters(await homesOf(server), wanted, SITES_PER_PASS)) {
        const reach = plan.radiusOf(wanted) + 1;
        const area = {
            x1: center.x - reach,
            y1: 0,
            z1: center.z - reach,
            x2: center.x + reach,
            y2: 0,
            z2: center.z + reach
        };
        const origin = await loaded(server, area, () => surveySite(server, wanted, center));
        if (origin) return origin;
    }
    return null;
}

/** Paste what is left of a build, a few chunks a pass. */
async function paste(
    server: ServerContainer,
    wanted: PolarisBuild,
    placed: plan.Placed
): Promise<void> {
    const box = placed.arena.box;
    const chunks = plan.pasteChunks(plan.pastePieces(wanted, { x: box.x1, y: box.y1, z: box.z1 }));
    const key = placed.arena.batch ?? batchKeyFor(server.installedAppId, wanted.id);
    // One this process stopped waiting for - restarted half way - is called off first.
    await cancelBatch(server, key);
    await loaded(server, box, async () => {
        let done = placed.pasted;
        for (const chunk of chunks.slice(done, done + CHUNKS_PER_PASS)) {
            if (!(await build(server, chunk, undefined, undefined, key))) return;
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
async function takeDown(server: ServerContainer, placed: plan.Placed): Promise<void> {
    if (placed.arena.batch) await cancelBatch(server, placed.arena.batch);
    const gone = await loaded(server, placed.arena.box, () =>
        build(server, plan.restoreLines(placed))
    );
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
            await takeDown(server, one);
        if (!decoration) return;
        for (const wanted of catalog.filter((one) => one.season === decoration)) {
            const existing = placed.find(
                (one) => one.id === wanted.id && one.season === decoration
            );
            if (existing?.up) continue;
            let target = existing;
            if (!target) {
                const origin = await findSite(server, wanted);
                if (!origin) continue;
                const fresh = plan.placedFor(
                    wanted,
                    origin,
                    batchKeyFor(server.installedAppId, wanted.id)
                );
                await writePlaced(server.installedAppId, (list) => [
                    ...list.filter((one) => !same(one, fresh)),
                    fresh
                ]);
                target = fresh;
            }
            await paste(server, wanted, target);
            return;
        }
    } finally {
        busy.delete(server.installedAppId);
    }
}
