import Fuse from "fuse.js";

/**
 * Finding a saved login by the little somebody remembers of its name.
 *
 * Pulled out of the worker for the reason the matching was: the module it lived
 * in cannot be imported outside an extension, so the box everybody types into
 * was the one part of the list with nothing pinning its behaviour.
 *
 * A plain substring filter answers nothing for a letter left out, a letter the
 * wrong way round, or a name half remembered - "githb", "amazn", a surname where
 * the entry is "Surname, Co" - and those are most of what gets typed into a box
 * this size. So the match is fuzzy, and ranked as well as filtered: the best
 * guess is the first row rather than whichever was stored first. The name counts
 * for more than the username, because two logins on one site differ by username
 * and the thing being looked for is the site.
 *
 * The first letter is the exception, and has to be. A fuzzy match scores a run
 * of characters, so a single letter either drags in the whole vault ranked by
 * noise or - with a minimum run length, which is what holds that back - matches
 * nothing at all, and an empty list on the first keystroke is the worse of the
 * two. A query too short to be scored that way is filtered the plain way
 * instead: every login with that letter in it, which is exactly what somebody
 * typing the first letter of a name is asking for.
 */

/** Enough of a login to search it: what it is called, and who it signs in as. */
export interface Searchable {
    readonly name: string;
    readonly username: string | null;
}

/** The shortest query a fuzzy match can say anything useful about, and the
 *  shortest run of characters one is allowed to be confident about. */
const MIN_FUZZY = 2;

/** Every login carrying the query, the way a plain filter finds them. */
function containing<T extends Searchable>(all: readonly T[], query: string): T[] {
    const wanted = query.toLowerCase();
    return all.filter(
        (login) =>
            login.name.toLowerCase().includes(wanted) ||
            (login.username ?? "").toLowerCase().includes(wanted)
    );
}

/** The logins somebody is looking for, best guess first. An empty query is
 *  everything, which is the list they were already looking at. */
export function searchLogins<T extends Searchable>(all: readonly T[], query: string): T[] {
    const wanted = query.trim();
    if (!wanted) return [...all];
    if (wanted.length < MIN_FUZZY) return containing(all, wanted);
    return new Fuse(all, {
        keys: [
            { name: "name", weight: 2 },
            { name: "username", weight: 1 }
        ],
        threshold: 0.35,
        // A match at the end of a name is worth as much as one at the start.
        ignoreLocation: true,
        // So a stray letter inside a longer query does not pull the rest of the
        // vault in behind it.
        minMatchCharLength: MIN_FUZZY
    })
        .search(wanted)
        .map((hit) => hit.item);
}
