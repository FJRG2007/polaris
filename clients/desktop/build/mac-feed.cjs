// @ts-check
/**
 * The macOS update feed: the JSON file Squirrel.Mac reads when the app points it
 * at a `json` server, one per architecture, attached to the release beside the
 * zip it names (`.github/workflows/desktop.yml`). The app reads it from the
 * release it found (`src/main/updates.ts`), so it lists that release only.
 *
 *     node build/mac-feed.cjs <arch> <version> <zip url> <directory>
 *
 * writes the architecture's feed into the directory.
 */

/** The file name for an architecture; `macFeedName` in src/main/releases.ts. */
function macFeedName(/** @type {string} */ arch) {
    return `RELEASES-darwin-${arch}.json`;
}

/** The feed for one release, in the format Electron documents for static
 *  storage: `currentRelease` and the release it updates to. */
function macFeed(/** @type {string} */ version, /** @type {string} */ url, /** @type {Date} */ published) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a version: ${version}`);
    if (!/^https:\/\/\S+\.zip$/.test(url)) throw new Error(`Not a zip's https address: ${url}`);
    const pubDate = published.toISOString();
    return {
        currentRelease: version,
        releases: [{ version, updateTo: { version, name: version, notes: "", pub_date: pubDate, url } }]
    };
}

module.exports = { macFeed, macFeedName };

if (require.main === module) {
    const { join } = require("node:path");
    const { writeFileSync } = require("node:fs");
    const [arch = "", version = "", url = "", directory = ""] = process.argv.slice(2);
    if (!/^(arm64|x64)$/.test(arch) || !directory) throw new Error("Usage: mac-feed.cjs <arch> <version> <zip url> <directory>");
    writeFileSync(join(directory, macFeedName(arch)), `${JSON.stringify(macFeed(version, url, new Date()), null, 2)}\n`);
}
