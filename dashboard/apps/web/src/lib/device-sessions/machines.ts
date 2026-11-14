/**
 * Which computer each row on a sessions screen comes from, so a list of a
 * browser, its extension, a terminal and a Stream Deck reads as the one machine
 * they all run on ("DRAGON") instead of four strangers.
 *
 * Nothing here is stored: a machine is read off what every row already holds -
 * the address it was last seen at and its operating system - and named by the
 * one kind of client that knows the computer's own name, a device app that
 * reported its hostname at sign-in (`namesMachine` in `./kinds`). A browser
 * cannot read that name, which is why it has to be borrowed.
 *
 * It is a reading, not a proof: two computers of the same system behind one
 * router look like one machine. That is why it only ever labels a row and never
 * decides anything - nothing is ended, trusted or hidden on the strength of it.
 *
 * Shared by server and client code.
 */

/** What a row says about where it runs. */
export interface MachineRow {
    readonly id: string;
    /** The address it was last seen at. A row with none is not placed. */
    readonly ip: string | null;
    readonly os: string;
    /** The reader's own browser session. */
    readonly current?: boolean;
    /** The computer's own name, where the client reported one. */
    readonly hostname?: string | null;
}

/** The machine a row was placed on. */
export interface Machine {
    /** The computer's name, when any row on it reported one. */
    readonly name: string | null;
    /** Whether it is the computer the reader is using right now. */
    readonly here: boolean;
}

/** The system's family - "Windows 11" and "Windows" are the same computer. */
function family(os: string): string {
    return os.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** Each placed row's machine, by row id. A row whose machine says nothing - the
 *  only row on it, or one nobody named that is not the reader's - has no entry. */
export function machinesOf(rows: readonly MachineRow[]): Map<string, Machine> {
    const groups = new Map<string, MachineRow[]>();
    for (const row of rows) {
        if (!row.ip) continue;
        const key = `${row.ip} ${family(row.os)}`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const placed = new Map<string, Machine>();
    for (const group of groups.values()) {
        const name = group.find((row) => row.hostname)?.hostname ?? null;
        const here = group.some((row) => row.current === true);
        if (group.length < 2 || (!name && !here)) continue;
        for (const row of group) placed.set(row.id, { name, here });
    }
    return placed;
}
