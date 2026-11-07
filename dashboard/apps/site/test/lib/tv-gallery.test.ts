import { describe, expect, it } from "vitest";
import { minSdkOf, tableRows, tvGallerySources } from "../../src/lib/tv-gallery";

const THEMES = [
    "# Themes",
    "",
    "| Theme | What it does | Screenshot |",
    "|---|---|---|",
    '| `dock-glass/` | A frosted `dock` | <img src="dock-glass/screenshot.jpg" width="320" alt="x"> |',
    '| `default/` | The built-in look | <img src="default/screenshot.png" width="320" alt="x"> |',
    "| `bare/` | No screenshot | |",
    '| `sneaky/` | Leaves its folder | <img src="sneaky/../default/screenshot.jpg" width="320"> |',
    '| `other/` | Someone else\'s picture | <img src="default/screenshot.jpg" width="320"> |',
    '| `Bad Id/` | Not a plain id | <img src="Bad Id/screenshot.jpg" width="320"> |',
    "",
    "## Keys",
    "",
    "| Key | Meaning |",
    "|---|---|",
    "| `x` | not a theme |"
].join("\n");

const ADDONS = [
    "| Add-on | What it does | Author | Tested on | Permissions | Screenshot |",
    "|---|---|---|---|---|---|",
    '| [Weather](weather/) | The [forecast](https://example.test) | [@a](https://example.test) | TV | Internet | <img src="weather/screenshot.jpg" width="240"> |',
    '| [Tatami](tatami/) | Rooms | [@b](https://example.test) | TV | None | <img src="tatami/screenshot.jpg" width="240"> |',
    "| Not a link | Skipped | | | | |"
].join("\n");

const sources = () =>
    tvGallerySources({
        themesReadme: THEMES,
        addonsReadme: ADDONS,
        launcherGradle: "android {\n    defaultConfig {\n        minSdk 21\n    }\n}",
        addon: (id) => ({
            gradle: id === "weather" ? "minSdkVersion 23" : null,
            manifest:
                id === "weather"
                    ? '<uses-permission android:name="android.permission.INTERNET" />'
                    : "<manifest />"
        })
    });

describe("tvGallerySources", () => {
    it("lists themes then add-ons, each sorted by id, as the release catalog does", () => {
        expect(sources().map((source) => `${source.item.kind}:${source.item.id}`)).toEqual([
            "addon:tatami",
            "addon:weather",
            "theme:default",
            "theme:dock-glass"
        ]);
    });

    it("reads each row's words, screenshot and what the add-on needs", () => {
        const byId = Object.fromEntries(sources().map((source) => [source.item.id, source]));
        expect(byId["dock-glass"]).toEqual({
            from: "themes/dock-glass/screenshot.jpg",
            item: {
                id: "dock-glass",
                kind: "theme",
                name: "Dock Glass",
                description: "A frosted dock",
                network: false,
                minSdk: 21,
                screenshot: "theme-dock-glass.jpg"
            }
        });
        expect(byId.default?.item.screenshot).toBe("theme-default.png");
        expect(byId.weather?.item).toMatchObject({
            name: "Weather",
            description: "The forecast",
            network: true,
            minSdk: 23,
            screenshot: "addon-weather.jpg"
        });
        expect(byId.tatami?.item).toMatchObject({ network: false, minSdk: null });
    });

    it("leaves out a row without a screenshot of its own or a plain id", () => {
        const ids = sources().map((source) => source.item.id);
        for (const id of ["bare", "sneaky", "other", "Bad Id"]) expect(ids).not.toContain(id);
    });
});

describe("tableRows", () => {
    it("reads only the first table under the header", () => {
        expect(tableRows(THEMES, "| Theme |")).toHaveLength(6);
        expect(tableRows("no table here", "| Theme |")).toEqual([]);
    });
});

describe("minSdkOf", () => {
    it("reads the Groovy and Kotlin spellings", () => {
        expect(minSdkOf("minSdk 26")).toBe(26);
        expect(minSdkOf("minSdk = 24")).toBe(24);
        expect(minSdkOf(null)).toBeNull();
    });
});
