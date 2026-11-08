import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/app-extensions/installed", () => ({
    installedExtensions: () => [
        {
            id: "translate",
            textTranslation: () => ({
                appId: "translate",
                endpoint: "/api/translate",
                page: "/translate",
                device: { module: "screens/selection-engines", name: "selectionEngines" }
            })
        }
    ]
}));

vi.mock("@/lib/app-bundles/code", () => ({
    withBundleSlot: (slot: unknown) => slot,
    bundleClientUrl: (app: string, module: string) =>
        module === "screens/selection-engines" ? `/api/app-bundles/${app}/1.0.0/client/x.js` : null
}));

describe("textTranslator device engines", () => {
    it("answers where the app's device module is served", async () => {
        const { textTranslator } = await import("@/lib/app-extensions/registry");
        expect(textTranslator(["translate"])?.device).toEqual({
            module: "screens/selection-engines",
            name: "selectionEngines",
            src: "/api/app-bundles/translate/1.0.0/client/x.js"
        });
    });
});
