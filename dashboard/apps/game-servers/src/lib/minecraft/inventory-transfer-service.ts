/**
 * Exporting bags to a file and importing them back, against the running server.
 *
 * The file and what an import changes are worked out in ./inventory-transfer,
 * which the screen shares. This side reads the bags, checks the server speaks
 * the file's syntax, and writes slot by slot through the same `writeSlot` every
 * other change goes through - each slot re-read first and left alone when it no
 * longer holds what the preview showed. A player who is not on gets the import
 * when they next join, through the waiting queue.
 */

import { prisma } from "@polaris/db";
import { stripFormatting } from "./parse";
import type { InventoryItem } from "./inventory";
import * as transfer from "./inventory-transfer";
import { AIR, itemArgument } from "./item-argument";
import { readSlot, sameStack, slotReplaced, writeSlot } from "./item-service";
import { withServerContainer, type ServerContainer } from "./service";
import {
    askerOf,
    readLiveInventories,
    readLiveInventory,
    readSnapshot,
    writeSnapshot,
    type LiveReading
} from "./inventory-service";

/** One player's bag as an export takes it: live when they are on, the kept copy when not. */
interface Bag {
    readonly name: string;
    readonly live: boolean;
    readonly takenAt: string;
    readonly items: InventoryItem[];
}

/** A player who is on: the reading just taken, kept as their snapshot, or the kept copy when it could not be read whole. */
async function bagOf(
    installedAppId: string,
    name: string,
    reading: LiveReading | null
): Promise<Bag | null> {
    if (reading?.answered && reading.unreadable === 0) {
        const takenAt = new Date();
        await writeSnapshot(installedAppId, name, reading.items, takenAt).catch(() => undefined);
        return { name, live: true, takenAt: takenAt.toISOString(), items: reading.items };
    }
    const kept = await readSnapshot(installedAppId, name);
    return kept ? { name, live: false, takenAt: kept.takenAt, items: kept.items } : null;
}

/** The version the server said it started as, when its log still says. */
async function serverVersion(server: ServerContainer): Promise<string | null> {
    const result = await server
        .run([
            "sh",
            "-c",
            "grep -m1 -o 'Starting minecraft server version [^ ]*' /data/logs/latest.log"
        ])
        .catch(() => null);
    return /version (\S+)/.exec(result?.output ?? "")?.[1] ?? null;
}

/** What the game answers to a harmless count when it read the item argument: a number found, or nobody to count on. */
const PARSED = /found \d+ matching|no items were found|no player was found|no entity was found/i;

/**
 * The syntax this server writes a stack's data in, asked of the game itself: a
 * count of zero stone with a component, then with a tag. Neither changes
 * anything. Null when it takes neither.
 */
export async function serverEra(
    server: ServerContainer,
    player: string
): Promise<transfer.Era | null> {
    const ask = async (item: string) =>
        PARSED.test(
            stripFormatting(await server.say(["clear", player, item, "0"]).catch(() => ""))
        );
    if (await ask("minecraft:stone[minecraft:custom_data={polaris:1b}]")) return "components";
    if (await ask("minecraft:stone{polaris:1b}")) return "tag";
    return null;
}

/** Bags as a file: the players named, or every player with a live reading or a kept copy. */
export async function exportBags(
    ownerId: string,
    installedAppId: string,
    names: readonly string[] | "all",
    online: readonly string[]
): Promise<{ file: transfer.TransferFile | null; missing: string[] }> {
    const wanted =
        names === "all" ? await everyKnownPlayer(installedAppId, online) : [...new Set(names)];
    return withServerContainer(ownerId, installedAppId, async (server) => {
        const onlineSet = new Set(online.map((name) => name.toLowerCase()));
        // Every bag that is on read together, in as few trips as they fit,
        // rather than a trip per player and one per stack of every big bag.
        const live = wanted.filter((name) => onlineSet.has(name.toLowerCase()));
        const readings = await readLiveInventories(askerOf(server), live).catch(() => null);
        const readingOf = new Map(live.map((name, index) => [name, readings?.[index] ?? null]));
        const bags: Bag[] = [];
        const missing: string[] = [];
        for (const name of wanted) {
            const bag = onlineSet.has(name.toLowerCase())
                ? await bagOf(installedAppId, name, readingOf.get(name) ?? null)
                : await readSnapshot(installedAppId, name).then((kept) =>
                      kept ? { name, live: false, takenAt: kept.takenAt, items: kept.items } : null
                  );
            if (bag) bags.push(bag);
            else missing.push(name);
        }
        if (bags.length === 0) return { file: null, missing };
        return { file: transfer.exportFile(bags, await serverVersion(server)), missing };
    });
}

async function everyKnownPlayer(
    installedAppId: string,
    online: readonly string[]
): Promise<string[]> {
    const kept = await prisma.playerInventorySnapshot.findMany({
        where: { installedAppId },
        select: { username: true },
        orderBy: { username: "asc" }
    });
    const seen = new Map<string, string>();
    for (const name of [...online, ...kept.map((row) => row.username)])
        if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
    return [...seen.values()];
}

/** One player's side of an import, as the preview shows it. */
export interface ImportPreview {
    readonly player: string;
    /** Whether they are on now, so it lands at once; otherwise it waits for them. */
    readonly online: boolean;
    /** What the plan was worked out against: live, the kept copy, or nothing known. */
    readonly basis: "live" | "kept" | "none";
    /** When the kept copy was read, for a plan worked out against it. */
    readonly keptAt: string | null;
    readonly plan: transfer.PlannedSlot[];
}

/** Who gets which bag: the file's own players by name, or one bag into one chosen player. */
export interface ImportTarget {
    readonly player: string;
    readonly items: InventoryItem[];
}

/**
 * What an import would do to each player, and whether the server takes the
 * file at all: a file read in another syntax is refused before anything is
 * worked out.
 */
export async function previewImport(
    ownerId: string,
    installedAppId: string,
    targets: readonly ImportTarget[],
    fileEra: transfer.FileEra,
    mode: transfer.ImportMode,
    online: readonly string[]
): Promise<{ era: transfer.Era | null; fits: boolean; previews: ImportPreview[] }> {
    return withServerContainer(ownerId, installedAppId, async (server) => {
        const era =
            fileEra === "plain" ? null : await serverEra(server, targets[0]?.player ?? "Steve");
        const fits = era === null ? fileEra === "plain" : transfer.eraFits(fileEra, era);
        if (!fits) return { era, fits, previews: [] };
        const onlineSet = new Set(online.map((name) => name.toLowerCase()));
        const previews: ImportPreview[] = [];
        for (const target of targets) {
            const isOn = onlineSet.has(target.player.toLowerCase());
            const live = isOn
                ? await readLiveInventory(askerOf(server), target.player).catch(() => null)
                : null;
            const kept = live?.answered ? null : await readSnapshot(installedAppId, target.player);
            const current = live?.answered ? live.items : (kept?.items ?? []);
            previews.push({
                player: target.player,
                online: isOn && live?.answered === true,
                basis: live?.answered ? "live" : kept ? "kept" : "none",
                keptAt: live?.answered ? null : (kept?.takenAt ?? null),
                plan: transfer.planImport(current, target.items, mode)
            });
        }
        return { era, fits, previews };
    });
}

/** How one player's import went. */
export interface ImportOutcome {
    readonly player: string;
    /** Slots written now. */
    readonly written: number;
    /** Slots left as they are: changed since the preview, or refused by the game. */
    readonly skipped: number[];
    /** Waiting for them to join. */
    readonly queued: boolean;
}

/**
 * Write one player's planned slots, now. Each is read again first and written
 * only while it still holds what the plan was worked out against; a slot that
 * changed meanwhile is left alone and reported.
 */
export async function applyPlanNow(
    server: ServerContainer,
    installedAppId: string,
    player: string,
    plan: readonly transfer.PlannedSlot[],
    /** The slots the game said it put a stack in: in, wherever it went next.
     *  Filled as each is answered, so a caller still has them if a later slot throws. */
    confirmed: number[] = []
): Promise<{ written: number; skipped: number[]; confirmed: number[] }> {
    let written = 0;
    const skipped: number[] = [];
    for (const one of transfer.writesOf(plan)) {
        const argument = one.after ? itemArgument(one.after) : null;
        if (argument && !argument.ok) {
            skipped.push(one.slot);
            continue;
        }
        const now = await readSlot(server, player, one.slot);
        if (!sameStack(now, one.before)) {
            skipped.push(one.slot);
            continue;
        }
        try {
            const reply =
                argument?.ok && one.after
                    ? await writeSlot(
                          server,
                          installedAppId,
                          player,
                          one.slot,
                          argument.value,
                          one.after.count
                      )
                    : await writeSlot(server, installedAppId, player, one.slot, AIR, 1);
            written += 1;
            if (slotReplaced(reply)) confirmed.push(one.slot);
        } catch {
            skipped.push(one.slot);
        }
    }
    return { written, skipped, confirmed };
}

/**
 * A waiting import, applied when the player joins: their bag is read then, the
 * plan worked out against it, and the server's syntax checked against the
 * file's again - a server updated meanwhile is refused with a reason, never
 * written in the wrong syntax.
 */
export async function applyQueuedImport(
    server: ServerContainer,
    installedAppId: string,
    player: string,
    items: readonly InventoryItem[],
    mode: transfer.ImportMode
): Promise<{ written: number; skipped: number[] }> {
    const fileEra = transfer.eraOf(items);
    if (fileEra !== "plain") {
        const era = await serverEra(server, player);
        if (era === null || !transfer.eraFits(fileEra, era)) throw new Error("era");
    }
    const reading = await readLiveInventory(askerOf(server), player);
    if (!reading.answered || reading.unreadable > 0) throw new Error("unread");
    return applyPlanNow(
        server,
        installedAppId,
        player,
        transfer.planImport(reading.items, items, mode)
    );
}
