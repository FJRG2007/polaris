/**
 * Every ready-made policy has a name and a line saying what it does, in every
 * language - the screen builds those keys from the template's own key, so a
 * template added without words would show a raw key.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POLICY_TEMPLATES } from "@polaris/core";

const LOCALES = ["en-US", "es-ES"] as const;

function templates(locale: string): Record<string, { name?: string; description?: string }> {
    const path = new URL(`../../messages/${locale}/admin.json`, import.meta.url);
    const messages = JSON.parse(readFileSync(path, "utf8")) as {
        policies: { templates: Record<string, { name?: string; description?: string }> };
    };
    return messages.policies.templates;
}

describe("ready-made policy words", () => {
    for (const locale of LOCALES) {
        it(`are all there in ${locale}`, () => {
            const words = templates(locale);
            for (const template of POLICY_TEMPLATES) {
                expect(words[template.key]?.name, template.key).toBeTruthy();
                expect(words[template.key]?.description, template.key).toBeTruthy();
            }
        });
    }
});
