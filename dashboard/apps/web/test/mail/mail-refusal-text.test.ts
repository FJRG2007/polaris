/**
 * Every sentence the mailbox layer refuses with, in the reader's language.
 *
 * The services under `lib/mailbox` throw in English, and the Mail actions hand
 * what they caught through `mailRefusalText` on its way to the screen. A
 * sentence that function does not know passes through untouched - which is
 * right for a mail server's own words and wrong for one Polaris wrote. This
 * reads every literal sentence thrown under `lib/mailbox` and holds each one to
 * coming out in Spanish, so a new refusal cannot reach a Spanish reader in
 * English unnoticed.
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { translatorFor } from "@/lib/i18n/translate";
import { MAIL_REFUSALS, mailRefusalText } from "@/lib/mailbox/refusal-text";

const LIB = fileURLToPath(new URL("../../src/lib/mailbox/", import.meta.url));

/** `throw new SomeError("A sentence.")`, the sentence possibly on the next line. */
const THROWN = /throw new \w+\(\s*"([^"\\]+)"/g;

async function thrownSentences(): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    for (const name of await readdir(LIB)) {
        if (!name.endsWith(".ts")) continue;
        const source = await readFile(`${LIB}${name}`, "utf8");
        for (const match of source.matchAll(THROWN)) {
            // A type-only helper whose body is never run.
            if (match[1] === "never called") continue;
            found.set(match[1]!, name);
        }
    }
    return found;
}

describe("a refusal from the mailbox layer", () => {
    const es = translatorFor("es-ES", "mail");
    const en = translatorFor("en-US", "mail");

    it("finds the sentences it is checking", async () => {
        // A regex that stopped matching would pass everything below.
        expect((await thrownSentences()).size).toBeGreaterThan(25);
    });

    it("has a Spanish sentence for every one Polaris writes", async () => {
        const untranslated = [...(await thrownSentences())]
            .filter(([sentence]) => mailRefusalText(es, sentence) === sentence)
            .map(([sentence, file]) => `${file}: ${sentence}`);
        expect(untranslated).toEqual([]);
    });

    it("reads the same in English as it was thrown", async () => {
        for (const [sentence, file] of await thrownSentences()) {
            expect(mailRefusalText(en, sentence), file).toBe(sentence);
        }
        for (const [sentence, key] of Object.entries(MAIL_REFUSALS)) {
            expect(en(key), key).toBe(sentence);
        }
    });

    it("passes a mail server's own words through as they came", () => {
        const said = "535 5.7.8 Error: authentication failed: UGFzc3dvcmQ6";
        expect(mailRefusalText(es, said)).toBe(said);
    });
});
