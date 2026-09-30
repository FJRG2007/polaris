import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Select } from "../src/components/select";

/**
 * A select's trigger is as wide as its layout makes it, and the chosen label is cut
 * to fit. In a language whose words run longer than the English the trigger was
 * sized for, the cut is where the meaning was - so the whole label rides along as
 * the trigger text's title.
 */
describe("the chosen label in a select", () => {
    it("carries its full text for when the trigger cuts it", () => {
        const markup = renderToStaticMarkup(
            createElement(Select, {
                value: "all",
                onValueChange: () => undefined,
                options: [{ value: "all", label: "Todos los servicios" }]
            })
        );
        expect(markup).toContain('title="Todos los servicios"');
    });

    it("adds no title for a label that is not text", () => {
        const markup = renderToStaticMarkup(
            createElement(Select, {
                value: "all",
                onValueChange: () => undefined,
                options: [{ value: "all", label: createElement("b", null, "All") }]
            })
        );
        expect(markup).not.toContain("title=");
    });
});
