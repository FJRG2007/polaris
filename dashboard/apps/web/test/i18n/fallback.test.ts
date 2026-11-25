/**
 * A production build never draws a translation key (BUG-0037): a message the
 * reader's catalog lacks is read from the source language's, one neither has is
 * blank, and the miss is reported. Outside production the key is drawn, so it
 * is seen.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@polaris/core";

const own = createTranslator("es-ES", { hello: "Hola", rich: "<b>Hola</b>" }, { namespace: "probe", onProblem: () => {} });
const source = createTranslator("en-US", { hello: "Hello", only: "Only in English" }, { namespace: "probe", onProblem: () => {} });

async function fresh() {
    vi.resetModules();
    return import("@/lib/i18n/fallback");
}

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe("a translator outside production", () => {
    it("is left as it is, so a missing key is drawn and seen", async () => {
        const { withFallback } = await fresh();
        const missed = vi.fn();
        const t = withFallback(own, source, missed);
        expect(t).toBe(own);
        expect(t("gone")).toBe("probe.gone");
    });
});

describe("a translator in production", () => {
    it("reads its own message, then the source's, then nothing, and reports only the last", async () => {
        vi.stubEnv("NODE_ENV", "production");
        const { withFallback } = await fresh();
        const missed = vi.fn();
        const t = withFallback(own, source, missed);
        expect(t("hello")).toBe("Hola");
        expect(t("only")).toBe("Only in English");
        expect(t("gone")).toBe("");
        expect(t.rich("gone", {})).toEqual([]);
        expect(t.rich("rich", { b: (parts: unknown[]) => parts.join("") })).toEqual(["Hola"]);
        expect(t.has("only")).toBe(true);
        expect(t.has("gone")).toBe(false);
        expect(t.locale).toBe("es-ES");
        expect(missed.mock.calls).toEqual([["gone"], ["gone"]]);
    });

    it("on the server, falls back to English and logs a key nobody has once", async () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.resetModules();
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const { translatorFor } = await import("@/lib/i18n/translate");
        const t = translatorFor("es-ES", "agents") as unknown as (key: string) => string;
        expect(t("session.switch.title")).not.toBe("agents.session.switch.title");
        expect(t("session.switch.noSuchKey")).toBe("");
        expect(t("session.switch.noSuchKey")).toBe("");
        const logged = error.mock.calls.filter((call) => String(call[0]).includes("agents.session.switch.noSuchKey"));
        expect(logged).toHaveLength(1);
    });
});
