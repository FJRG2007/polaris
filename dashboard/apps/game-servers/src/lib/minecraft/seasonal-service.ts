/**
 * Telling each running Minecraft server which season to dress for (`seasonal.ts`
 * decides, the server's Polaris jar draws it).
 *
 * A sweep every two minutes. While a season is on, every running server that
 * has the jar is told again on every pass - the jar keeps what it was told for
 * an hour, so a server that restarted picks it up within a pass, and one that
 * lost Polaris takes the decorations down by itself. Out of season a server is
 * told to clear once and then left alone: a jar that just started has nothing
 * up but what it keeps across a restart, so a server that was stopped is told
 * once it is back. A server's own switch tells it at once.
 */

import { prisma } from "@polaris/db";
import * as seasonal from "./seasonal";
import * as winter from "./seasonal-winter";
import { host } from "@polaris/app-host";
import { readSchedule } from "./schedule";
import { readEventState } from "./events/state";
import { withServerContainer } from "./service";
import { capsReading, forgetCapabilities } from "./events/in-server";
import { chosenLanguage, readEventsConfig } from "./events/catalog";
import * as halloween from "./seasonal-halloween";
import { homeLanguage } from "./speech-service";
import { readPlaced } from "./world-builds/plan";
import { reconcileWorldBuilds } from "./world-builds/service";

const { readInstallConfig, patchInstallConfig } = host.appsInstallConfig;
/** The deployment's switch, read from the host when asked rather than as this
 *  loads: the events loop loads this too, for an arena's season. */
const seasonsAllowed = () => host.seasonalService.seasonsAllowed();

/** How long a server with no Polaris jar at all is left before it is asked again:
 *  it answers the same until somebody adds one. */
const NO_JAR_RETRY_MS = 30 * 60_000;

/** How long a server with an older Polaris jar is left before it is asked again.
 *  Short, because the restart that loads the newer jar Polaris keeps on it is
 *  usually the very next thing the operator does - and a longer wait is a server
 *  that has just restarted onto a jar that can decorate, showing nothing for half
 *  an hour. One console line per pass is the whole cost. */
const OLD_JAR_RETRY_MS = 90_000;

/** How long a stopped server is left out of season before it is looked at again:
 *  once it is back it is told to clear, for what its jar kept across the stop. */
const STOPPED_RETRY_MS = 10 * 60_000;

/** Servers told at once on a sweep: each is a console trip or two. */
const SWEEP_CONCURRENCY = 8;

/** Per server, the last line it took (and whether its jar was too old for the
 *  mob settings), or when its Polaris jar was found too old to decorate, or when
 *  it answered with no Polaris jar at all. */
const told = new Map<
    string,
    | {
          readonly line: string;
          readonly mobsMissing?: boolean;
          readonly halloweenMissing?: boolean;
          /** Out of season or paused, whether the jar has nothing left to take
           *  down for a switch-off (told so, or cannot take the line). */
          readonly offTold?: boolean;
          readonly winterMissing?: boolean;
          /** When it was found stopped, so never told the line it is held to. */
          readonly stoppedAt?: number;
      }
    | { readonly oldJarAt: number }
    | { readonly noJarAt: number }
>();

/** When this server may be asked again, if it is being left alone for now. */
function askAgainAt(last: ReturnType<typeof told.get>): number | null {
    if (last && "oldJarAt" in last) return last.oldJarAt + OLD_JAR_RETRY_MS;
    if (last && "noJarAt" in last) return last.noJarAt + NO_JAR_RETRY_MS;
    return null;
}

interface ServerRow {
    readonly id: string;
    readonly ownerId: string;
    readonly config: string | null;
}

/** The time zone a server's days are read in: its events', as its challenges use. */
function zoneOf(config: Record<string, unknown>): string {
    return readEventsConfig(config, readSchedule(config).timezone).settings.timezone;
}

/** What one server should be showing now. */
export function decorationOf(
    config: Record<string, unknown>,
    allowed: boolean,
    now: Date
): seasonal.Decoration | null {
    return seasonal.decorationNow({
        now,
        timeZone: zoneOf(config),
        allowed,
        serverOn: seasonal.seasonalOn(config),
        eventRunning: readEventState(config).run !== null
    });
}

/** The language a server's players read what the jar says in. */
function serverLanguage(ownerId: string, config: Record<string, unknown>): Promise<"en" | "es"> {
    return homeLanguage(ownerId, chosenLanguage(config)).catch(() => "en" as const);
}

/**
 * The season an event's arena is dressed for (`events/kinds/arena-decor`): the
 * server's own, under the same switches, read whether or not an event is
 * running - the event is what it dresses. Null out of season, switched off, or
 * when it cannot be read: an arena is never held up by its decorations.
 */
export async function eventDecoration(
    installedAppId: string,
    now: Date = new Date()
): Promise<seasonal.Decoration | null> {
    try {
        const [row, allowed] = await Promise.all([
            prisma.installedApp.findUnique({
                where: { id: installedAppId },
                select: { config: true }
            }),
            seasonsAllowed().catch(() => true)
        ]);
        if (!row) return null;
        const config = readInstallConfig(row.config);
        return seasonal.decorationNow({
            now,
            timeZone: zoneOf(config),
            allowed,
            serverOn: seasonal.seasonalOn(config),
            eventRunning: false
        });
    } catch (error) {
        console.warn("polaris: the season for an event could not be read", String(error));
        return null;
    }
}

/**
 * The Halloween line for one server, in its own language. Switched off, it
 * carries graves off and no season left, so the jar takes its graveyards down
 * now instead of keeping them to the season's end as it does for a restart or
 * an event's pause.
 */
async function halloweenCommandFor(
    ownerId: string,
    config: Record<string, unknown>,
    now: Date,
    switchedOff = false
): Promise<string> {
    const language = await serverLanguage(ownerId, config);
    const settings = halloween.halloweenSettings(config);
    if (switchedOff) return halloween.halloweenCommand({ ...settings, graves: 0 }, 0, language, 0);
    return halloween.halloweenCommand(
        settings,
        halloween.bloodNightKey(now, zoneOf(config)),
        language,
        halloween.halloweenSecondsLeft(now, zoneOf(config))
    );
}

/** Halloween is on the calendar but the server's switch or the deployment's is off. */
function halloweenSwitchedOff(
    config: Record<string, unknown>,
    allowed: boolean,
    now: Date
): boolean {
    if (allowed && seasonal.seasonalOn(config)) return false;
    return seasonal.decorationFor(seasonal.seasonInZone(now, zoneOf(config))) === "halloween";
}

/** Tell one server. A line it already took out of season is not sent again. */
async function tell(row: ServerRow, allowed: boolean, now: Date): Promise<boolean> {
    const config = readInstallConfig(row.config);
    const decoration = decorationOf(config, allowed, now);
    const clearLine = seasonal.seasonCommand(null);
    const last = told.get(row.id);
    const again = askAgainAt(last);
    if (again !== null && now.getTime() < again) return false;
    const switchedOff = !decoration && halloweenSwitchedOff(config, allowed, now);
    if (
        !decoration &&
        last &&
        "line" in last &&
        last.line === clearLine &&
        (!switchedOff || last.offTold === true) &&
        readPlaced(config).length === 0 &&
        (last.stoppedAt === undefined || now.getTime() < last.stoppedAt + STOPPED_RETRY_MS)
    )
        return false;
    return withServerContainer(row.ownerId, row.id, async (server) => {
        // A server that is down shows nothing; what its jar kept is cleared once it is back.
        if (!server.running || server.edition !== "java") {
            told.set(
                row.id,
                server.edition === "java"
                    ? { line: clearLine, stoppedAt: now.getTime() }
                    : { line: clearLine }
            );
            return false;
        }
        const reading = await capsReading(server);
        // Nobody answered, as a console that is still starting does: asked
        // again on the next pass, not taken for a server without the jar.
        if (reading.answer === "none") {
            forgetCapabilities(row.id);
            return false;
        }
        // Builds in the world are plain commands: up or down whatever the jar.
        await reconcileWorldBuilds(server, config, decoration).catch((caught: unknown) =>
            console.error(`[minecraft-seasonal] world builds on ${row.id}:`, caught)
        );
        if (!reading.caps.has("season")) {
            told.set(
                row.id,
                reading.answer === "polaris"
                    ? { oldJarAt: now.getTime() }
                    : { noJarAt: now.getTime() }
            );
            return false;
        }
        // A jar from before the mob settings is told the season alone: it
        // refuses a line with more on it.
        const mobs = reading.caps.has(seasonal.MOBS_CAP);
        const line = seasonal.seasonCommand(
            decoration,
            mobs ? seasonal.seasonalMobs(config) : null
        );
        const lines = [line];
        const hasHalloween = reading.caps.has(halloween.HALLOWEEN_CAP);
        const halloweenLine =
            decoration === "halloween" && hasHalloween
                ? await halloweenCommandFor(row.ownerId, config, now)
                : null;
        if (halloweenLine) lines.push(halloweenLine);
        // Switched off is not paused: the graveyards come down with the rest.
        if (switchedOff && hasHalloween)
            lines.unshift(await halloweenCommandFor(row.ownerId, config, now, true));
        // Christmas and New Year ride on the winter, for a jar that takes them.
        const winterJar = reading.caps.has(winter.WINTER_CAP);
        if (decoration === "winter" && winterJar) {
            lines.push(
                winter.winterCommand(
                    winter.winterSettings(config),
                    winter.winterCalendar(now, zoneOf(config)),
                    await serverLanguage(row.ownerId, config)
                )
            );
        }
        // Each line its own command. `say` takes one command's words, and the
        // console tool joins them with spaces: handed the season and Halloween
        // lines together it sent one long line the jar refused as a whole, so
        // no season reached it at all.
        await server.sayAll(lines);
        told.set(row.id, {
            line,
            mobsMissing: decoration !== null && !mobs,
            halloweenMissing: decoration === "halloween" && !halloweenLine,
            offTold: switchedOff || !hasHalloween,
            winterMissing: decoration === "winter" && !winterJar
        });
        return true;
    }).catch((caught: unknown) => {
        console.error(`[minecraft-seasonal] could not tell ${row.id} the season:`, caught);
        return false;
    });
}

/** Every Minecraft server, told what to show. */
export async function sweepSeasons(now: Date = new Date()): Promise<{ told: number }> {
    const [rows, allowed] = await Promise.all([
        prisma.installedApp.findMany({
            where: {
                status: { not: "removed" },
                catalogId: "minecraft",
                applicationId: { not: null }
            },
            select: { id: true, ownerId: true, config: true }
        }),
        seasonsAllowed().catch(() => true)
    ]);
    let count = 0;
    let next = 0;
    const worker = async () => {
        while (next < rows.length) {
            const row = rows[next++]!;
            if (await tell(row, allowed, now)) count += 1;
        }
    };
    await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, rows.length) }, worker));
    return { told: count };
}

/** One server's switch, and what it is showing because of it. */
export interface SeasonalView {
    readonly on: boolean;
    /** What it shows now with this switch; null when out of season, or off. */
    readonly showing: seasonal.Decoration | null;
    /** What the season is regardless of this server's switch. */
    readonly season: seasonal.Decoration | null;
    /** The deployment's switch is off: nothing shows anywhere. */
    readonly blocked: boolean;
    /** An event is running here; the decorations wait for it to end. */
    readonly paused: boolean;
    /** The server's jar was found too old to decorate: it needs a restart to
     *  load the one Polaris keeps on it. */
    readonly needsRestart: boolean;
    /** The server answered with no Polaris plugin or mod to draw them. */
    readonly unavailable: boolean;
    /** Halloween night spawns, as a multiple of the usual. */
    readonly nightSpawns: number;
    /** Halloween and winter snow golems, as a multiple of the usual few. */
    readonly snowGolems: number;
    /** The server's jar shows the decorations but predates the seasonal mobs:
     *  a restart loads the one that brings them. */
    readonly mobsNeedRestart: boolean;
    /** Halloween's extra touches (`seasonal-halloween.ts`). */
    readonly halloween: halloween.HalloweenSettings;
    /** The jar shows Halloween but predates its extra touches. */
    readonly halloweenNeedsRestart: boolean;
    /** Christmas and New Year's Eve on this server. */
    readonly winter: winter.WinterSettings;
    /** The server's jar shows the winter but predates Christmas and New Year:
     *  a restart loads the one that brings them. */
    readonly winterNeedsRestart: boolean;
}

export async function seasonalView(installedAppId: string): Promise<SeasonalView> {
    const [row, allowed] = await Promise.all([
        prisma.installedApp.findUnique({ where: { id: installedAppId }, select: { config: true } }),
        seasonsAllowed().catch(() => true)
    ]);
    const config = readInstallConfig(row?.config);
    const now = new Date();
    const last = told.get(installedAppId);
    return {
        on: seasonal.seasonalOn(config),
        showing: decorationOf(config, allowed, now),
        season: seasonal.decorationFor(seasonal.seasonInZone(now, zoneOf(config))),
        blocked: !allowed,
        paused: readEventState(config).run !== null,
        needsRestart: last !== undefined && "oldJarAt" in last,
        unavailable: last !== undefined && "noJarAt" in last,
        ...seasonal.seasonalMobs(config),
        mobsNeedRestart: last !== undefined && "line" in last && last.mobsMissing === true,
        halloween: halloween.halloweenSettings(config),
        halloweenNeedsRestart:
            last !== undefined && "line" in last && last.halloweenMissing === true,
        winter: winter.winterSettings(config),
        winterNeedsRestart: last !== undefined && "line" in last && last.winterMissing === true
    };
}

/** What a save may change; whatever is left out stays as it is. */
export interface SeasonalPatch {
    readonly on?: boolean;
    readonly nightSpawns?: number;
    readonly snowGolems?: number;
    readonly halloween?: Partial<halloween.HalloweenSettings>;
    readonly winter?: winter.WinterPatch;
}

/** Change this server's seasonal settings, and tell it now. */
export async function setSeasonal(
    ownerId: string,
    installedAppId: string,
    patch: SeasonalPatch
): Promise<SeasonalView> {
    const changes: Record<string, unknown> = {};
    // Absent is on, so on is written as removing the key.
    if (patch.on !== undefined) changes[seasonal.SEASONAL_KEY] = patch.on ? null : false;
    if (patch.nightSpawns !== undefined) changes[seasonal.NIGHT_SPAWNS_KEY] = patch.nightSpawns;
    if (patch.snowGolems !== undefined) changes[seasonal.SNOW_GOLEMS_KEY] = patch.snowGolems;
    const halloweenPatch = patch.halloween;
    const winterPatch =
        patch.winter !== undefined && Object.keys(patch.winter).length > 0
            ? patch.winter
            : undefined;
    await patchInstallConfig(installedAppId, (config) => ({
        ...changes,
        ...(halloweenPatch === undefined
            ? {}
            : { [halloween.HALLOWEEN_KEY]: halloween.patchHalloween(config, halloweenPatch) }),
        ...(winterPatch === undefined
            ? {}
            : { [winter.WINTER_KEY]: winter.patchWinter(config, winterPatch) })
    }));
    // Asked again now rather than when the last answer runs out, so a server
    // restarted onto a newer jar is reached on the switch.
    told.delete(installedAppId);
    const [row, allowed] = await Promise.all([
        prisma.installedApp.findUnique({
            where: { id: installedAppId },
            select: { id: true, ownerId: true, config: true }
        }),
        seasonsAllowed().catch(() => true)
    ]);
    if (row) await tell({ ...row, ownerId }, allowed, new Date());
    return seasonalView(installedAppId);
}
