/**
 * The browser voice Polar falls back on: the one that speaks the answer's
 * language, the exact regional one first and the browser's default first.
 */

import { describe, expect, it } from "vitest";
import { pickBrowserVoice } from "@/lib/polar/browser-voice";

const voice = (lang: string, isDefault = false) => ({ lang, default: isDefault, name: lang });

describe("the browser voice", () => {
    it("prefers the exact language, then the same language elsewhere", () => {
        const voices = [voice("en-US", true), voice("es-MX"), voice("es-ES")];
        expect(pickBrowserVoice(voices, "es-ES")?.lang).toBe("es-ES");
        expect(pickBrowserVoice(voices, "es-AR")?.lang).toBe("es-MX");
        expect(pickBrowserVoice(voices, "es")?.lang).toBe("es-MX");
    });

    it("prefers the browser's default among equals, and reads Android's underscores", () => {
        const voices = [voice("es_ES"), voice("es-ES", true)];
        expect(pickBrowserVoice(voices, "es-ES")).toBe(voices[1]);
        expect(pickBrowserVoice([voice("es_ES")], "es-es")?.lang).toBe("es_ES");
    });

    it("leaves the choice to the browser when no voice speaks the language", () => {
        expect(pickBrowserVoice([voice("en-US", true)], "ja-JP")).toBeNull();
        expect(pickBrowserVoice([], "en-US")).toBeNull();
    });
});
