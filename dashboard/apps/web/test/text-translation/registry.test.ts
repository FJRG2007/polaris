import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/app-extensions/installed", () => ({
    installedExtensions: () => [
        { id: "games" },
        {
            id: "translate",
            textTranslation: () => ({ appId: "translate", endpoint: "/api/translate", page: "/translate" })
        }
    ]
}));

describe("textTranslator", () => {
    it("is offered only when the reader reaches the app that translates", async () => {
        const { textTranslator } = await import("@/lib/app-extensions/registry");
        expect(textTranslator(["chat"])).toBeNull();
        expect(textTranslator(["chat", "translate"])).toEqual({
            appId: "translate",
            endpoint: "/api/translate",
            page: "/translate"
        });
    });
});
