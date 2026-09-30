/**
 * The extension's words, and the language it picks.
 *
 * The account's language when its Polaris named one the extension speaks, the
 * browser's otherwise; both catalogs hold the same messages; and the browser's
 * own strings - the name, the description, the shortcut - exist in every
 * language the manifest points at.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flattenCatalog } from "@polaris/core";
import config from "../wxt.config";
import english from "../src/messages/en-US.json";
import spanish from "../src/messages/es-ES.json";
import { menuEntries } from "../src/lib/context-menu";
import { timeoutChoices } from "../src/lib/lock";
import { readIntendedLogin } from "../src/lib/save";
import { unlockRefusal } from "../src/lib/unlock";
import { ENGLISH, pickLocale, wordsIn } from "../src/lib/words";

const spanishWords = wordsIn("es-ES");

describe("the catalogs", () => {
    it("hold the same messages in both languages", () => {
        expect([...flattenCatalog(spanish).keys()].sort()).toEqual(
            [...flattenCatalog(english).keys()].sort()
        );
    });
});

describe("the language", () => {
    it("is the account's when it names one the extension speaks", () => {
        expect(pickLocale("es-ES")).toBe("es-ES");
        expect(pickLocale("en-US")).toBe("en-US");
    });

    it("falls back to the browser's for anything else", () => {
        // No browser here, so the page's own language list answers: the test
        // runner's, which is English.
        expect(pickLocale("fr-FR")).toBe(pickLocale(null));
        expect(pickLocale(undefined)).toBe(pickLocale(null));
    });
});

describe("the modules say what they said before, in English", () => {
    it("names the menu entries and the lock choices", () => {
        expect(menuEntries().map((entry) => entry.title)).toEqual([
            "Fill the login for this site",
            "Generate a password",
            "Fill the one-time code",
            "Fill my email"
        ]);
        expect(timeoutChoices().map((choice) => choice.label)).toEqual([
            "1 minute",
            "5 minutes",
            "15 minutes",
            "30 minutes",
            "1 hour",
            "4 hours",
            "When the browser closes"
        ]);
        expect(unlockRefusal("wrong")).toBe("That password did not open the vault.");
        expect(ENGLISH("errors.silentWorker")).toBe("Polaris did not answer. Open this again.");
    });
});

describe("in Spanish", () => {
    it("reads the menu, the lock and a refusal", () => {
        expect(menuEntries(spanishWords)[3]?.title).toBe("Poner mi correo");
        expect(timeoutChoices(spanishWords)[4]?.label).toBe("1 hora");
        const refused = readIntendedLogin(
            { name: "", username: "", password: "", uri: "" },
            spanishWords
        );
        expect(refused.ok ? null : refused.error).toBe(
            "Ponle un nombre para poder encontrarlo después."
        );
        expect(
            spanishWords("shell.greeting", { part: "morning", hasName: "yes", name: "Ana" })
        ).toBe("Buenos días, Ana");
    });
});

describe("what the browser draws itself", () => {
    type ManifestEnv = { browser: string; manifestVersion: 2 | 3 };
    const build = config.manifest as unknown as (env: ManifestEnv) => Record<string, unknown>;
    const read = (language: string) =>
        JSON.parse(
            readFileSync(
                new URL(`../public/_locales/${language}/messages.json`, import.meta.url),
                "utf8"
            )
        ) as Record<string, { message: string }>;

    it("comes from the locale files, English first, in every language they hold", () => {
        for (const manifestVersion of [2, 3] as const) {
            const manifest = build({
                browser: manifestVersion === 2 ? "firefox" : "chrome",
                manifestVersion
            });
            expect(manifest["default_locale"]).toBe("en");
            expect(manifest["name"]).toBe("__MSG_extName__");
            expect(manifest["description"]).toBe("__MSG_extDescription__");
        }
        const en = read("en");
        const es = read("es");
        expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
        expect(en["extName"]?.message).toBe("Polaris");
        expect(en["extDescription"]?.message).toBe("Polaris in your toolbar.");
        expect(en["commandFillLogin"]?.message).toBe("Fill the login for this page");
        expect(es["extDescription"]?.message).toBe("Polaris en tu barra de herramientas.");
    });
});
