/**
 * An app's screenshots are the README's own captures, in the reader's language,
 * and an app without any shows none.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POLARIS_APP_CATALOG } from "@/lib/apps/catalog";
import { builtInApps } from "@/lib/apps/marketplace-store";
import { appScreenshots, builtInScenes, screenshotLanguage } from "@/lib/apps/app-screenshots";

const PUBLIC = resolve(__dirname, "../../public");
const MEDIA = resolve(__dirname, "../../../../../docs/assets/media");

describe("app screenshots", () => {
    it("picks the capture in the reader's language", () => {
        expect(screenshotLanguage("es-ES")).toBe("es");
        expect(screenshotLanguage("en-US")).toBe("en");
        expect(screenshotLanguage("fr-FR")).toBe("en");
        expect(appScreenshots("calendar", "es-ES")[0]!.dark.desktop).toBe(
            "/marketplace/calendar-dark-es-desktop.webp"
        );
    });

    it("shows none for an app that has no captures", () => {
        expect(appScreenshots("minecraft", "en-US")).toEqual([]);
        expect(appScreenshots("unknown-app", "en-US")).toEqual([]);
    });

    it("every file a page can ask for is shipped, in both themes and languages", () => {
        let count = 0;
        for (const app of POLARIS_APP_CATALOG) {
            for (const locale of ["en-US", "es-ES"]) {
                for (const shot of appScreenshots(app.id, locale)) {
                    for (const file of [
                        shot.dark.desktop,
                        shot.dark.mobile,
                        shot.light.desktop,
                        shot.light.mobile
                    ]) {
                        expect(existsSync(resolve(PUBLIC, `.${file}`)), file).toBe(true);
                        count += 1;
                    }
                }
            }
        }
        expect(count).toBeGreaterThan(0);
    });

    it("every built-in app has captures, each taken in both themes, languages and sizes", () => {
        for (const app of builtInApps()) {
            const scenes = builtInScenes(app.id);
            expect(scenes.length, app.id).toBeGreaterThan(0);
            for (const scene of scenes)
                for (const theme of ["dark", "light"])
                    for (const language of ["en", "es"])
                        for (const form of ["desktop", "mobile"]) {
                            const file = `${scene}-${theme}-${language}-${form}.webp`;
                            expect(existsSync(resolve(MEDIA, file)), file).toBe(true);
                        }
        }
    });
});
