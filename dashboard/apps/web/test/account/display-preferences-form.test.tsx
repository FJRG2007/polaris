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

function render(options: { allowInherit: boolean; mine?: Record<string, string> }): string {
    return renderToStaticMarkup(
        <DisplayPreferencesForm
            initial={options.mine ?? {}}
            fallback={resolveDisplayPreferences({ weekStart: "sun" })}
            allowInherit={options.allowInherit}
            save={async () => ({})}
        />
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
});
