/**
 * What an ARK server is made of: its ports, its footprint and the environment the
 * image is started with.
 *
 * Pure, and separate from the allocation that picks the ports for exactly that
 * reason - the create dialog says what a server will cost before anything exists,
 * and a module that reaches for the database cannot be rendered in a browser.
 *
 * The awkward part is the ports. ARK does not publish one door but three, and two
 * of them are tied together: the raw socket has to be exactly one above the game
 * port, and that is true on the player's side of the mapping as well as inside the
 * container - a client told to connect on 19140 looks for the raw socket on 19141
 * whatever the container is doing internally. So the three cannot be mapped
 * independently the way a single-port app's can, and the server is told to bind
 * exactly the ports Polaris published for it.
 */

import { withExclusiveJoin } from "@/lib/apps/ark/access";
import type { CreateArkServerInput } from "@/lib/apps/games-schema";

/** The port an ARK client assumes, and what Polaris starts looking from. */
export const PREFERRED_GAME_PORT = 7777;

/** Game, raw socket, server list. Consecutive because the first two have to be. */
export const ARK_PORT_RUN = 3;

export interface ArkPorts {
    /** What a player types after the address. */
    readonly game: number;
    /** The raw socket, always the game port plus one. */
    readonly raw: number;
    /** Where the Steam server browser asks. */
    readonly query: number;
}

/** The three ports, from the first of a run. */
export function arkPortsFrom(first: number): ArkPorts {
    return { game: first, raw: first + 1, query: first + 2 };
}

/**
 * What an ARK server is likely to use, from how many people are on it.
 *
 * An estimate, and presented as one - unlike a JVM heap this is not a limit
 * anything enforces, it is what the process grows to. It exists so the machine
 * picker can say whether the next server fits: ARK's floor is high enough that
 * "it will be fine" is wrong often enough to matter.
 */
export function expectedArkMemoryMb(concurrentPlayers: number): number {
    const raw = 6144 + Math.max(0, concurrentPlayers) * 60;
    return Math.min(Math.ceil(raw / 512) * 512, 32768);
}

/**
 * The environment the image is started with.
 *
 * Every value the create dialog collected, plus the three that decide what the
 * server binds. The launch options are built rather than typed, because the flag
 * that closes the server lives in the same string as everything else.
 */
export function arkServerEnv(input: CreateArkServerInput, ports: ArkPorts): Record<string, string> {
    return {
        SESSION_NAME: input.sessionName,
        SERVER_MAP: input.map,
        SERVER_PASSWORD: input.joinPassword,
        MAX_PLAYERS: String(input.maxPlayers),
        ...(input.mods && input.mods.length > 0 ? { GAME_MOD_IDS: normalizeModIds(input.mods) } : {}),
        ARK_EXTRA_OPTS: withExclusiveJoin("", input.exclusiveJoin),
        GAME_CLIENT_PORT: String(ports.game),
        UDP_SOCKET_PORT: String(ports.raw),
        SERVER_LIST_PORT: String(ports.query)
    };
}

/** Workshop ids as steamcmd wants them: the numbers, comma separated, with the
 *  spacing somebody typed taken back out. */
export function normalizeModIds(value: string): string {
    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .join(",");
}
