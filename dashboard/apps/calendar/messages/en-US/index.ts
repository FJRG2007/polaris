/**
 * US English: the source catalog of Calendar. Its keys are the ones every other
 * locale must carry, and the types every `t("...")` in the app is checked
 * against. See dashboard/docs/i18n.md.
 */

import screens from "./calendar.json";
import more from "./more.json";
import server from "./server.json";
import calendarRule from "./rule.json";

/** One namespace from three files: what the calendar screens say, what the
 *  booking, sharing and account screens say, and what the server says
 *  (refusals, notifications, mail). Their top-level keys never overlap. */
export default { calendar: { ...screens, ...more, ...server }, calendarRule };
