/**
 * The periods a key's usage can be read over. Apart from the report so the
 * screen can offer them without pulling the database client into the browser.
 */

export const USAGE_RANGES = ["24h", "7d", "30d", "90d"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];
