/**
 * A page drawn in a right-to-left language: Radix primitives are told the
 * direction by the provider every page sits in, and shared components draw
 * classes that mirror under `dir="rtl"` rather than physical ones.
 */

import { useDirection } from "@polaris/ui";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@polaris/core", async (original) => {
    const core = await original<typeof import("@polaris/core")>();
    // No right-to-left locale ships yet; Spanish stands in for one here.
    return { ...core, localeDirection: (locale: string) => (locale === "es-ES" ? "rtl" : "ltr") };
});

const { withMessages } = await import("../setup/i18n");
const { Switch } = await import("@polaris/ui");

function Probe() {
    return <span data-dir={useDirection()} />;
}

/** Every class token in the markup. */
function classes(markup: string): string[] {
    return [...markup.matchAll(/class="([^"]*)"/g)].flatMap((match) => match[1]!.split(/\s+/));
}

const PHYSICAL = /^(?:[\w-]+:)*-?(?:m[lr]|p[lr]|left|right)-|^(?:[\w-]+:)*(?:text-(?:left|right)|rounded-[lr]|border-[lr])(?:-|$)/;

describe("a right-to-left page", () => {
    it("hands Radix the locale's direction", () => {
        expect(renderToStaticMarkup(withMessages(<Probe />, "en-US"))).toContain('data-dir="ltr"');
        expect(renderToStaticMarkup(withMessages(<Probe />, "es-ES"))).toContain('data-dir="rtl"');
    });

    it("moves a switch's thumb toward the end of the line in both directions", () => {
        const on = renderToStaticMarkup(
            <div dir="rtl">
                <Switch checked onChange={() => {}} aria-label="on" />
            </div>
        );
        const thumb = classes(on).filter((name) => name.includes("translate-x"));
        expect(thumb).toEqual(["translate-x-[1.125rem]", "rtl:-translate-x-[1.125rem]"]);
        expect(classes(on).filter((name) => PHYSICAL.test(name))).toEqual([]);
    });
});
