import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isOfflinePage } from "../../src/main/reachability";

const OFFLINE_PAGE = join(__dirname, "../../../dashboard/apps/web/public/offline.html");

describe("the page a gone Polaris's worker answers with", () => {
    it("is recognized in both of its languages", () => {
        expect(isOfflinePage("Polaris is not reachable")).toBe(true);
        expect(isOfflinePage(" No se puede acceder a Polaris ")).toBe(true);
    });

    it("is not confused with a page of the Polaris", () => {
        expect(isOfflinePage("Polaris")).toBe(false);
        expect(isOfflinePage("")).toBe(false);
    });

    it("keeps the titles the desktop app looks for", () => {
        const page = readFileSync(OFFLINE_PAGE, "utf8");
        expect(page).toContain("<title>Polaris is not reachable</title>");
        expect(page).toContain('title: "No se puede acceder a Polaris"');
    });
});
