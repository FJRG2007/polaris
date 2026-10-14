/**
 * Who walked into the call and who walked out, from two sources that disagree
 * about when.
 *
 * The roster is the record: a seat is in it from the moment somebody is let in
 * until the server marks it left. But a closed tab is only marked left when the
 * server's sweep gets to it, so a departure read off the roster alone sounded
 * long after the person had gone. The call server sees them go first - it drops
 * their connection - and that is what makes a leave prompt.
 *
 * So both feed one record of who has been announced. A seat the call server saw
 * leave is announced then, and the roster still listing it for a while after is
 * not read as them arriving again. Each change is announced once, whichever
 * source reported it first.
 *
 * Pure, so the rules can be checked without a call.
 */

export interface Presence {
    /** Seats announced as here, by seat id, with the name to say. */
    readonly present: ReadonlyMap<string, string>;
    /** Seats the call server saw leave that the roster still lists. */
    readonly departed: ReadonlyMap<string, string>;
}

export interface PresenceChange {
    readonly state: Presence;
    /** Names, in the order they changed. */
    readonly joined: readonly string[];
    readonly left: readonly string[];
}

/**
 * The admitted seats worth announcing, by seat id with the name to say, or null
 * while this browser's own seat is not in the room - there is no call to
 * announce anything in yet, and a first roster read before it would make its
 * own arrival news.
 *
 * Every seat of this account is left out, not only this browser's: the same
 * person picking the call up in another tab or on their phone, or a seat taken
 * back after a drop, is not somebody arriving. A guest has no account, so only
 * their own seat is.
 */
export function othersInRoom(
    participants: readonly {
        readonly id: string;
        readonly userId: string | null;
        readonly name: string;
        readonly admission: string;
    }[],
    self: string | null
): Map<string, string> | null {
    const admitted = participants.filter((person) => person.admission === "admitted");
    const mine = admitted.find((person) => person.id === self);
    if (!mine) return null;
    return new Map(
        admitted
            .filter((person) =>
                mine.userId === null ? person.id !== mine.id : person.userId !== mine.userId
            )
            .map((person) => [person.id, person.name] as const)
    );
}

/** The first roster seen: whoever is already here is not arriving. */
export function startPresence(roster: ReadonlyMap<string, string>): Presence {
    return { present: new Map(roster), departed: new Map() };
}

/** A new roster of the admitted seats. This browser's own seat is kept in the
 *  record and never announced. */
export function fromRoster(
    state: Presence,
    roster: ReadonlyMap<string, string>,
    self: string | null
): PresenceChange {
    const joined: string[] = [];
    const left: string[] = [];
    const present = new Map<string, string>();
    const departed = new Map<string, string>();
    for (const [id, name] of roster) {
        // Gone already, and the roster has not caught up.
        if (state.departed.has(id)) {
            departed.set(id, name);
            continue;
        }
        present.set(id, name);
        if (!state.present.has(id) && id !== self) joined.push(name);
    }
    for (const [id, name] of state.present) if (!roster.has(id) && id !== self) left.push(name);
    return { state: { present, departed }, joined, left };
}

/** The call server dropped a seat. */
export function fromMediaLeft(state: Presence, id: string): PresenceChange {
    const name = state.present.get(id);
    if (name === undefined) return { state, joined: [], left: [] };
    const present = new Map(state.present);
    present.delete(id);
    const departed = new Map(state.departed);
    departed.set(id, name);
    return { state: { present, departed }, joined: [], left: [name] };
}

/** The call server took a seat it had dropped back. Anything else arriving is
 *  the roster's to announce, since only the roster knows it was let in. */
export function fromMediaJoined(state: Presence, id: string): PresenceChange {
    const name = state.departed.get(id);
    if (name === undefined) return { state, joined: [], left: [] };
    const departed = new Map(state.departed);
    departed.delete(id);
    const present = new Map(state.present);
    present.set(id, name);
    return { state: { present, departed }, joined: [name], left: [] };
}

/** What one toast says about a batch of changes: the translation key and its
 *  values, or null when there is nothing to say. Arrivals first: somebody
 *  walking in is the news when both happen at once. */
export function arrivalNotice(
    joined: readonly string[],
    left: readonly string[]
): { key: "joined" | "joinedMany" | "left" | "leftMany"; name: string; others: number } | null {
    const [names, one, many] =
        joined.length > 0
            ? ([joined, "joined", "joinedMany"] as const)
            : ([left, "left", "leftMany"] as const);
    const first = names[0];
    if (first === undefined) return null;
    return names.length === 1
        ? { key: one, name: first, others: 0 }
        : { key: many, name: first, others: names.length - 1 };
}
