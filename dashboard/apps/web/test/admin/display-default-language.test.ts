/**
 * Saving the deployment's default language from Display defaults.
 *
 * The form sends the whole set; the action is what stands between it and the
 * stored blob, so it is held to the same schema the form checks against, to
 * administrators only, and to an audit entry that says which language was set.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DISPLAY_DEFAULTS, displayPreferencesSchema } from "@polaris/core";

const requireAdmin = vi.fn(async () => ({ id: "admin-1" }));
const recordAudit = vi.fn(async () => undefined);
const savePlatformDisplayPreferences = vi.fn(async () => undefined);

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireAdmin }));
vi.mock("@/lib/audit-service", () => ({ recordAudit }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/display-prefs-service", () => ({
    savePlatformDisplayPreferences,
    setUsersMayChooseTheme: vi.fn()
}));

const { savePlatformDisplayAction } = await import("@/app/(app)/admin/display/actions");

beforeEach(() => {
    requireAdmin.mockClear();
    recordAudit.mockClear();
    savePlatformDisplayPreferences.mockClear();
});

describe("saving the default language", () => {
    it("stores a supported language and audits which one", async () => {
        const result = await savePlatformDisplayAction({ ...DISPLAY_DEFAULTS, language: "es-ES" });
        expect(result).toEqual({});
        expect(savePlatformDisplayPreferences).toHaveBeenCalledWith(
            expect.objectContaining({ language: "es-ES" })
        );
        expect(recordAudit).toHaveBeenCalledWith({
            actorId: "admin-1",
            action: "admin.display.updated",
            metadata: { language: "es-ES" }
        });
    });

    it("refuses a language Polaris has no catalogs for, and stores nothing", async () => {
        const result = await savePlatformDisplayAction({ ...DISPLAY_DEFAULTS, language: "fr-FR" });
        expect(result.error).toBeTruthy();
        expect(savePlatformDisplayPreferences).not.toHaveBeenCalled();
        expect(recordAudit).not.toHaveBeenCalled();
    });

    it("refuses a save that leaves the language out, since the platform's set is complete", async () => {
        const { language: _dropped, ...rest } = DISPLAY_DEFAULTS;
        expect((await savePlatformDisplayAction(rest)).error).toBeTruthy();
        expect(displayPreferencesSchema.safeParse(rest).success).toBe(false);
    });

    it("is for administrators only", async () => {
        requireAdmin.mockRejectedValueOnce(new Error("forbidden"));
        await expect(savePlatformDisplayAction({ ...DISPLAY_DEFAULTS, language: "es-ES" })).rejects.toThrow();
        expect(savePlatformDisplayPreferences).not.toHaveBeenCalled();
    });
});
