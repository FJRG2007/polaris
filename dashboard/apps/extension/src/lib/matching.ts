import { hostOf, uriMatches, URI_MATCH_NEVER, type UriMatch } from "@polaris/core";

/**
 * Which saved logins belong to the page somebody is looking at, and which one
 * comes first.
 *
 * Extracted from the worker for one reason: this is the decision that puts a
 * password into a form, and while it lived beside the browser APIs it could not
 * be tested at all - the module it was in cannot be imported outside an
 * extension. A wrong answer here is a password typed into the wrong site, which
 * is the worst thing this product could do, so it is the part that most deserves
 * to be pinned by tests rather than reasoned about.
 *
 * The matching itself is `@polaris/core`'s `uriMatches`, the same function the
 * Polaris screens use, so a URI that matches in the dashboard matches here. What
 * is added is only the two rules around it: `never` is honoured, and the closer
 * host wins.
 *
 * Deliberately not here: "the one you used last", which is how Bitwarden breaks a
 * tie. It needs somewhere to remember that, and remembering which site somebody
 * signed into last is a record this extension does not currently keep anywhere.
 */

/** One address a login is saved for, and how strictly it is meant to match. */
export interface SavedUri {
    readonly uri: string;
    readonly match: UriMatch | null;
}

/** Enough of an item to decide whether it is for this page. */
export interface Matchable {
    readonly name: string;
    readonly uris: readonly SavedUri[];
}

/**
 * Whether any of an item's addresses covers this page.
 *
 * `never` is checked before the match rather than relying on `uriMatches` to
 * refuse it: it is the only escape hatch somebody has for an item they do not
 * want offered anywhere, and it should not depend on how another function reads
 * a strategy it does not recognise.
 */
export function matchesPage(uris: readonly SavedUri[], url: string): boolean {
    return uris.some(
        (entry) => entry.match !== URI_MATCH_NEVER && uriMatches(entry.uri, entry.match, url)
    );
}

/**
 * The items for this page, closest first.
 *
 * An exact host before a base-domain match: on a site with a login for the site
 * itself and another for its account subdomain, the closer one is the one meant.
 * Ties go to the name, so the order is stable - a list that reshuffles between
 * two openings is a list somebody cannot learn.
 */
export function rankForPage<T extends Matchable>(items: readonly T[], url: string): T[] {
    const host = hostOf(url);
    const closeness = (item: T): number =>
        item.uris.some((entry) => hostOf(entry.uri) === host) ? 0 : 1;
    return items
        .filter((item) => matchesPage(item.uris, url))
        .sort((left, right) => closeness(left) - closeness(right) || left.name.localeCompare(right.name));
}

/** The address a list shows beside an item, which is the first one saved. */
export function displayHost(uris: readonly SavedUri[]): string | null {
    return uris[0] ? hostOf(uris[0].uri) : null;
}
