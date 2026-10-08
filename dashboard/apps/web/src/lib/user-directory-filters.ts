/**
 * The cuts the people directory offers. Its own module so the screen and the
 * query that narrows by them read one list - the service that runs the query
 * cannot be imported by a screen.
 */

/** The cuts an operator reaches for; anything finer is what search is for. */
export const DIRECTORY_FILTERS = ["all", "admins", "limited", "banned"] as const;

export type DirectoryFilter = (typeof DIRECTORY_FILTERS)[number];
