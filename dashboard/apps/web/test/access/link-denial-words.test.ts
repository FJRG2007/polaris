/**
 * Every refusal a public link can give has words on the page, in both shipped
 * languages, and none of them names one kind of link: the same sentence is
 * shown for a file, a note, a form or a place.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));

const { linkDenialMessage } = await import("@/lib/link-denial");

const REASONS = [
    "revoked",
    "expired",
    "exhausted",
    "scheduled",
    "outside_hours",
    "ip_not_allowed",
    "country_not_allowed",
    "sign_in_required",
    "not_invited"
] as const;

function denied(locale: string): Record<string, string> {
    const url = new URL(`../../messages/${locale}/publicPages.json`, import.meta.url);
    return JSON.parse(readFileSync(url, "utf8")).denied;
}

describe("public link refusals", () => {
    it("gives every reason its own sentence rather than the generic one", async () => {
        for (const reason of REASONS) {
            expect(await linkDenialMessage(reason)).not.toBe("denied.unavailable");
        }
        expect(await linkDenialMessage("outside_hours")).toBe("denied.closed");
    });

    it("has the words in English and Spanish, about a link rather than one kind of thing", async () => {
        for (const locale of ["en-US", "es-ES"]) {
            const words = denied(locale);
            for (const reason of REASONS) {
                const key = (await linkDenialMessage(reason)).replace("denied.", "");
                expect(words[key], `${locale} ${key}`).toBeTruthy();
                expect(words[key]).not.toMatch(/snippet|fragmento/i);
            }
        }
    });
});
