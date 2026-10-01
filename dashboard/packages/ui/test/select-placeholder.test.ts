import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { Select } from "../src/components/select";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * "Nothing chosen" is `value=""` plus a placeholder. That "" must reach Radix as
 * itself - it is how Radix knows to draw the placeholder - and only an option that
 * is itself worth "" travels under the sentinel. Translated regardless, the trigger
 * believed a missing option was chosen and drew nothing at all.
 */
describe("a select with nothing chosen", () => {
    it("draws its placeholder", () => {
        const markup = renderToStaticMarkup(
            createElement(Select, {
                value: "",
                placeholder: "No preset",
                onValueChange: () => undefined,
                options: [{ value: "auto", label: "Auto" }]
            })
        );
        expect(markup).toContain("No preset");
        expect(markup).toContain("data-placeholder");
    });

    it("still shows an option that is worth the empty string", () => {
        const markup = renderToStaticMarkup(
            createElement(Select, {
                value: "",
                placeholder: "Pick one",
                onValueChange: () => undefined,
                options: [
                    { value: "", label: "Any type" },
                    { value: "file", label: "File" }
                ]
            })
        );
        expect(markup).toContain("Any type");
        expect(markup).not.toContain("Pick one");
    });
});
