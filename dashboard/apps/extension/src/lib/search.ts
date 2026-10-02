import { searchItems, type SearchField } from "@polaris/core/search-text";

/**
 * Finding a saved login by the little somebody remembers of its name.
 *
 * Pulled out of the worker for the reason the matching was: the module it lived
 * in cannot be imported outside an extension, so the box everybody types into
 * was the one part of the list with nothing pinning its behaviour.
 *
 * The matching is the search every Polaris list runs: every word typed has to
 * be in the name or the username, a single letter is every login carrying it,
 * and a letter left out or turned around ("githb", "amazn") is forgiven in the
 * name only when nothing matched as typed. The name counts for more than the
 * username, because two logins on one site differ by username and the thing
 * being looked for is the site.
 */

/** Enough of a login to search it: what it is called, and who it signs in as. */
export interface Searchable {
    readonly name: string;
    readonly username: string | null;
}

const LOGIN_FIELDS: readonly SearchField<Searchable>[] = [
    { text: (login) => login.name, weight: 2 },
    { text: (login) => login.username, weight: 1 }
];

/** The logins somebody is looking for, best guess first. An empty query is
 *  everything, which is the list they were already looking at. */
export function searchLogins<T extends Searchable>(all: readonly T[], query: string): T[] {
    return searchItems<T>(all, query, LOGIN_FIELDS);
}
