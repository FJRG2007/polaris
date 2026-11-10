/**
 * Every catalog entry that installs one of Polaris's own apps wears that app's
 * logo in the store, so its card is the tile the launcher shows once it is
 * installed - not a line icon on a tint.
 */

import { hasAppLogo } from "@polaris/ui";
import { describe, expect, it } from "vitest";
import { POLARIS_APP_CATALOG } from "@/lib/apps/catalog";
import { ownAppLogo } from "@/components/app-mark";

describe("Polaris's own apps in the store", () => {
    it("wear their own logo whenever Polaris has one for them", () => {
        const builtIn = POLARIS_APP_CATALOG.filter((app) => app.installMethod === "builtin");
        expect(builtIn.length).toBeGreaterThan(10);
        const missing = builtIn
            .filter((app) => hasAppLogo(app.id) && ownAppLogo(app.id) === null)
            .map((app) => app.id);
        expect(missing).toEqual([]);
    });

    it("include Analytics and Telemetry", () => {
        expect(ownAppLogo("analytics")).toBe("analytics");
        expect(ownAppLogo("telemetry")).toBe("telemetry");
    });
});
