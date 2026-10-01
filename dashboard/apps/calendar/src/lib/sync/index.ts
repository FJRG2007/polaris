/**
 * The external-calendar clients, as the sync engine imports them.
 *
 * One entry point on purpose: the engine picks a provider by account kind and
 * should not need to know which file each protocol lives in.
 */

export * from "./errors";
export * from "./provider";
export { type Fetcher } from "./http";
export { discoverCalDav, createCalDavProvider, normalizeServerUrl } from "./caldav";
export { createGoogleProvider } from "./google";
export { createGraphProvider, patternToRrule, ruleToPattern } from "./graph";
export {
    fetchIcsFeed,
    createIcsProvider,
    feedUrl,
    maskFeedAddress,
    FEED_REMOTE_ID,
    type FeedResult
} from "./ics-feed";
export { CALDAV_PRESETS, presetUrl, type CalDavPreset, type CalDavPresetId } from "./presets";
export { HOLIDAY_CALENDARS, type HolidayCalendar } from "./holidays";
export { parseXml, XmlError, type XmlElement } from "./xml";
