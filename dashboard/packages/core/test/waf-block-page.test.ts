/**
 * The block page is the only thing the firewall ever shows a person, and most of what it
 * shows arrives in a request header - so what is tested here is that it stays a page
 * rather than a hole: no value rendered as markup, no header long enough to be a payload
 * of its own, and no word about which rule matched.
 */

import { describe, expect, it } from "vitest";
import { wafBlockPage } from "../src/waf-block-page.js";

const REFERENCE = "2f9a1c5e-7b64-4c2f-9a3d-16b0c8f4e7d1";

describe("wafBlockPage", () => {
    it("names the site, the address judged, and the reference", () => {
        const page = wafBlockPage({ reference: REFERENCE, host: "app.example.com", ip: "203.0.113.5" });

        expect(page).toContain("app.example.com");
        expect(page).toContain("203.0.113.5");
        expect(page).toContain(REFERENCE);
    });

    it("says nothing about which rule matched", () => {
        const page = wafBlockPage({ reference: REFERENCE, host: "app.example.com" });

        expect(page.toLowerCase()).not.toContain("rule:");
        expect(page.toLowerCase()).not.toContain("injection");
    });

    it("escapes a host that carries markup", () => {
        const page = wafBlockPage({ reference: REFERENCE, host: "<script>alert(1)</script>" });

        expect(page).not.toContain("<script>alert(1)</script>");
        expect(page).toContain("&lt;script&gt;");
    });

    it("caps a header long enough to be a payload of its own", () => {
        const page = wafBlockPage({ reference: REFERENCE, host: "a".repeat(5000) });

        expect(page).not.toContain("a".repeat(200));
    });

    it("leaves out the address when there is none to show", () => {
        expect(wafBlockPage({ reference: REFERENCE, host: "app.example.com" })).not.toContain("Your IP");
    });

    it("states the reason when the caller has one that is safe to state", () => {
        const page = wafBlockPage({
            reference: REFERENCE,
            host: "app.example.com",
            explanation: "Your account does not have access to this service."
        });

        expect(page).toContain("Your account does not have access to this service.");
        expect(page).not.toContain("This site runs a firewall.");
    });
});
