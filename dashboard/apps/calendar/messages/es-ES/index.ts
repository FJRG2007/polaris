/**
 * Spanish as written in Spain. Same namespaces and keys as en-US - a missing one
 * is a type error in `messages/index.ts` and a failure in the catalog test.
 */

import screens from "./calendar.json";
import more from "./more.json";
import server from "./server.json";
import calendarRule from "./rule.json";

/** One namespace from three files: what the calendar screens say, what the
 *  booking, sharing and account screens say, and what the server says
 *  (refusals, notifications, mail). Their top-level keys never overlap. */
export default { calendar: { ...screens, ...more, ...server }, calendarRule };
