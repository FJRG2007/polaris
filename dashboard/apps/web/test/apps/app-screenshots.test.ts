/**
 * An app's screenshots are the README's own captures, in the reader's language,
 * and an app without any shows none.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POLARIS_APP_CATALOG } from "@/lib/apps/catalog";
import { appScreenshots, screenshotLanguage } from "@/lib/apps/app-screenshots";

const PUBLIC = resolve(__dirname, "../../public");

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
});
