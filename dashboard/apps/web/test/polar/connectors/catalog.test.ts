/**
 * The connector catalog: every address is the vendor's own, over https, and a
 * vendor with no official server has no address at all.
 */

import { describe, expect, it } from "vitest";
import {
    CONNECTOR_CATALOG,
    catalogEntry,
    catalogUrl,
    entryForUrl,
    urlMatchesEntry,
    type AvailableEntry
} from "@/lib/polar/connectors/catalog";
import { connectorInputSchema } from "@/lib/polar/connectors/policy";

/** The only addresses the catalog may carry: the vendor-documented ones. */
const DOCUMENTED = new Set([
    "https://mcp.stripe.com",
    "https://agent.binance.com/mcp/agentic",
    "https://mcp.cloudflare.com/mcp",
    "https://docs.mcp.cloudflare.com/mcp",
    "https://containers.mcp.cloudflare.com/mcp",
    "https://browser.mcp.cloudflare.com/mcp",
    "https://{shop}/api/mcp",
    "https://demandapi-mcp.booking.com/v1/sp/mcp/",
    "https://ajo-mcp.adobe.io/mcp",
    "https://cja-mcp.adobe.io/mcp",
    "https://aa-mcp.adobe.io/mcp",
    "https://targetmcp.adobe.io/mcp",
    "https://rtcdp-mcp.adobe.io/mcp",
    "https://mcp.adobeaemcloud.com/adobe/mcp/aem",
    "https://marketo-mcp.adobe.io/mcp"
]);

const available = CONNECTOR_CATALOG.filter((entry): entry is AvailableEntry => entry.available);

describe("connector catalog", () => {
    it("has unique ids and only documented https addresses", () => {
        const ids = CONNECTOR_CATALOG.map((entry) => entry.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const entry of available) {
            expect(entry.endpoint.startsWith("https://")).toBe(true);
            expect(entry.docs.startsWith("https://")).toBe(true);
            expect(DOCUMENTED.has(entry.endpoint)).toBe(true);
        }
        expect(new Set(available.map((entry) => entry.endpoint))).toEqual(DOCUMENTED);
    });

    it("lists no vendor that publishes no server of its own", () => {
        for (const id of ["spotify", "linkedin"]) expect(catalogEntry(id)).toBeNull();
        expect(CONNECTOR_CATALOG.every((entry) => entry.available)).toBe(true);
    });

    it("fills the Shopify template only with a valid store domain", () => {
        const shop = catalogEntry("shopify-storefront") as AvailableEntry;
        expect(catalogUrl(shop, "Name.myshopify.com")).toBe("https://name.myshopify.com/api/mcp");
        expect(catalogUrl(shop, "https://shop.example.com/")).toBe(
            "https://shop.example.com/api/mcp"
        );
        for (const bad of ["", "localhost", "a b.com", "evil.com/x", "user@evil.com", "x.com:8080"]) {
            expect(catalogUrl(shop, bad)).toBeNull();
        }
    });

    it("matches a stored address to its entry, the trailing slash aside", () => {
        const booking = catalogEntry("booking") as AvailableEntry;
        expect(urlMatchesEntry(booking, "https://demandapi-mcp.booking.com/v1/sp/mcp")).toBe(true);
        expect(urlMatchesEntry(booking, "https://demandapi-mcp.booking.com/v1/other")).toBe(false);
        expect(entryForUrl("https://mcp.stripe.com")?.id).toBe("stripe");
        expect(entryForUrl("https://example.com/mcp")).toBeNull();
    });

    it("asks for exactly the Booking.com headers, and they pass the header rules", () => {
        const booking = catalogEntry("booking") as AvailableEntry;
        expect(booking.keepTrailingSlash).toBe(true);
        const parsed = connectorInputSchema.safeParse({
            name: booking.name,
            url: booking.endpoint,
            auth: "headers",
            catalogId: booking.id,
            headers: booking.headers!.map((header) => ({ name: header.name, value: "123" }))
        });
        expect(parsed.success).toBe(true);
    });
});
