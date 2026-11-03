/**
 * Which engine answers: the owner's switches and the keys present decide what
 * is usable, the browser goes first, and a request that names an engine never
 * gets another one.
 */

import { describe, expect, it } from "vitest";
import {
    pickEngine,
    pickServerEngine,
    usableEngines,
    usableServerEngines
} from "@polaris-app/translate/src/model/engines";
import { DEFAULT_SETTINGS, type TranslateSettings } from "@polaris-app/translate/src/model/schemas";

const ALL = { deepl: true, google: true, polar: true };
const NONE = { deepl: false, google: false, polar: false };

function only(engines: Partial<TranslateSettings["engines"]>): TranslateSettings {
    return { ...DEFAULT_SETTINGS, engines: { ...DEFAULT_SETTINGS.engines, ...engines } };
}

describe("server engines", () => {
    it("try DeepL, then Google, then Polar's model", () => {
        expect(usableServerEngines(ALL, DEFAULT_SETTINGS)).toEqual(["deepl", "google", "polar"]);
        expect(pickServerEngine(ALL, DEFAULT_SETTINGS)).toBe("deepl");
    });

    it("skip what has no key and what the owner switched off", () => {
        expect(pickServerEngine({ ...ALL, deepl: false }, DEFAULT_SETTINGS)).toBe("google");
        expect(pickServerEngine(ALL, only({ deepl: false, google: false }))).toBe("polar");
    });

    it("answer nothing when nothing is usable", () => {
        expect(pickServerEngine(NONE, DEFAULT_SETTINGS)).toBeNull();
        expect(
            pickServerEngine(ALL, only({ deepl: false, google: false, polar: false }))
        ).toBeNull();
    });

    it("use the engine asked for, or none - never another", () => {
        expect(pickServerEngine(ALL, DEFAULT_SETTINGS, "polar")).toBe("polar");
        expect(pickServerEngine({ ...ALL, google: false }, DEFAULT_SETTINGS, "google")).toBeNull();
        expect(pickServerEngine(ALL, only({ google: false }), "google")).toBeNull();
    });
});

describe("the screen's engines", () => {
    it("put the browser first when it has a translator and the owner allows it", () => {
        expect(
            usableEngines({ browser: true, available: ALL, settings: DEFAULT_SETTINGS })
        ).toEqual(["browser", "deepl", "google", "polar"]);
        expect(
            usableEngines({ browser: true, available: NONE, settings: only({ browser: false }) })
        ).toEqual([]);
        expect(
            usableEngines({ browser: false, available: NONE, settings: DEFAULT_SETTINGS })
        ).toEqual([]);
    });

    it("follow the administrator's order, the browser included", () => {
        const order = {
            ...DEFAULT_SETTINGS,
            order: ["polar", "google", "browser", "deepl"] as TranslateSettings["order"]
        };
        expect(usableEngines({ browser: true, available: ALL, settings: order })).toEqual([
            "polar",
            "google",
            "browser",
            "deepl"
        ]);
        expect(usableServerEngines(ALL, order)).toEqual(["polar", "google", "deepl"]);
        expect(pickServerEngine({ ...ALL, polar: false }, order)).toBe("google");
    });

    it("keep the reader's pick while it is usable, else the first", () => {
        expect(pickEngine(["browser", "deepl"], "deepl")).toBe("deepl");
        expect(pickEngine(["browser", "deepl"], "google")).toBe("browser");
        expect(pickEngine([], null)).toBeNull();
    });
});
