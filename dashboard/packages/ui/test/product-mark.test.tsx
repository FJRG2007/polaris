import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { hasAppLogo } from "../src/shell/app-logo";
import { ProductMark, type PolarisProduct } from "../src/shell/product-mark";

const PRODUCTS: PolarisProduct[] = [
    "chat",
    "drive",
    "mail",
    "calendar",
    "tasks",
    "office",
    "vault",
    "polar",
    "notes",
    "crm",
    "automations",
    "translate"
];

/**
 * Another product's logo beside the words that name it: the product's own
 * logo, decorative, at text size, and never squeezed by the row it sits in.
 */
describe("product mark", () => {
    it("draws every product it accepts with that product's own logo", () => {
        for (const app of PRODUCTS) {
            expect(hasAppLogo(app)).toBe(true);
            const html = renderToStaticMarkup(createElement(ProductMark, { app }));
            expect(html).toContain(`data-app-logo="${app}"`);
            expect(html).toContain('aria-hidden="true"');
        }
    });

    it("sits at text size and does not shrink", () => {
        const html = renderToStaticMarkup(createElement(ProductMark, { app: "drive" }));
        expect(html).toContain('width="16"');
        expect(html).toContain("flex-shrink:0");
    });

    it("takes a size for smaller text", () => {
        const html = renderToStaticMarkup(createElement(ProductMark, { app: "chat", size: 12 }));
        expect(html).toContain('width="12"');
    });
});
