/**
 * The units-and-formats form, which both the account page and the platform
 * defaults page render.
 *
 * What is asserted is what the two pages differ on: an account may leave a field
 * on the platform's choice and is told what that resolves to, while the platform
 * form has no such option because there is no layer under it. The week start is
 * checked by name, since it is the one choice that changes how a calendar is
 * drawn rather than how a value is written.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DISPLAY_DEFAULTS, resolveDisplayPreferences } from "@polaris/core";
import { DisplayPreferencesForm } from "@/components/display-preferences-form";
import { withMessages } from "../setup/i18n";

function render(options: {
    allowInherit: boolean;
    allowLanguage?: boolean;
    mine?: Record<string, string>;
}): string {
    return renderToStaticMarkup(
        withMessages(
            <DisplayPreferencesForm
                initial={options.mine ?? {}}
                fallback={resolveDisplayPreferences({ weekStart: "sun" })}
                allowInherit={options.allowInherit}
                allowLanguage={options.allowLanguage}
                save={async () => ({})}
            />
        )
    );
}

describe("the preferences form", () => {
    it("offers the week start, and starts everyone on Sunday", () => {
        expect(DISPLAY_DEFAULTS.weekStart).toBe("sun");
        expect(render({ allowInherit: true })).toContain("Week starts on");
    });

    it("tells an account what the platform default resolves to", () => {
        expect(render({ allowInherit: true })).toContain("Platform default (Sunday)");
    });

    it("gives the platform form no inherit option, since nothing sits under it", () => {
        expect(render({ allowInherit: false })).not.toContain("Platform default");
    });

    it("previews the week the chosen day produces", () => {
        expect(render({ allowInherit: true, mine: { weekStart: "mon" } })).toContain("Mon to Sun");
        expect(render({ allowInherit: true, mine: { weekStart: "sat" } })).toContain("Sat to Fri");
    });

    it("offers the platform a default language, each named in itself, with what it is for", () => {
        const html = render({ allowInherit: false, allowLanguage: true, mine: resolveDisplayPreferences({}) as never });
        expect(html).toContain("Language");
        expect(html).toContain("Used only when a person has not picked one and their device does not say.");
        expect(html).toContain("English (US)");
    });

    it("leaves the language off an account's form, which has its own card for it", () => {
        expect(render({ allowInherit: true })).not.toContain("their device does not say");
    });

    it("previews an amount in the chosen default language", () => {
        const spanish = { ...resolveDisplayPreferences({}), language: "es-ES", currency: "EUR" } as never;
        const english = { ...resolveDisplayPreferences({}), language: "en-US", currency: "EUR" } as never;
        expect(render({ allowInherit: false, allowLanguage: true, mine: spanish })).toContain("1234,50");
        expect(render({ allowInherit: false, allowLanguage: true, mine: english })).toContain("1,234.50");
    });
});
