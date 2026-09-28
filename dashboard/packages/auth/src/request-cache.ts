/**
 * Memoized for the length of one request, and not a moment longer.
 *
 * A page asks the same questions about the same account many times over: the
 * frame decides which of some twenty apps to draw, each by a permission check,
 * and every check resolved the account's roles, groups, policies and grants
 * again from scratch - six or seven queries each, a couple of hundred for one
 * navigation, all at once against the same connection pool. Inside one request
 * the answer cannot change underneath the page, so it is worked out once.
 *
 * React's `cache` is scoped to the request that is being rendered (a page, a
 * layout, a server action). Anywhere else - a cron, a test, a script - it calls
 * straight through, so nothing outside a request ever sees a remembered answer.
 */

export { cache as perRequest } from "react";
