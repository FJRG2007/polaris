/**
 * The language last translated into is remembered on this device, and only a
 * language Translate offers is ever read back from storage.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readLastTarget, writeLastTarget } from "@polaris-app/translate/src/screens/last-target";

describe("the last translation language", () => {
    beforeEach(() => {
        const stored = new Map<string, string>();
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => stored.get(key) ?? null,
            setItem: (key: string, value: string) => void stored.set(key, value)
        });
    });

    it("is nothing until one is picked", () => {
        expect(readLastTarget()).toBeNull();
    });

    it("reads back the language last picked", () => {
        writeLastTarget("es");
        writeLastTarget("pt-BR");
        expect(readLastTarget()).toBe("pt-BR");
    });

    it("ignores a stored value that is not a language Translate offers", () => {
        localStorage.setItem("polaris:translate-to", "<script>");
        expect(readLastTarget()).toBeNull();
    });
});
