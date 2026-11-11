/**
 * The connector catalog: official remote MCP servers, each one at the address
 * its vendor documents and nowhere else. A vendor that publishes no server of
 * its own is not listed at all - a third-party listing is somebody else's
 * server, and Polar does not offer it under the vendor's name.
 *
 * Every entry is added through the same path as a custom connector; the
 * catalog only decides the address, how it signs in and what the dialog asks.
 * Pure and client-safe: the settings screen and the server both read it.
 */

import { z } from "zod";

export const CATALOG_CATEGORIES = [
    "payments",
    "finance",
    "developer",
    "commerce",
    "travel",
    "marketing"
] as const;
export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

/** How a catalog entry signs in. `oauth_or_bearer`: OAuth, or a key pasted as a bearer token. */
export type CatalogAuth = "none" | "oauth" | "oauth_or_bearer" | "headers";

/** One header the dialog asks for, and the shape its value must have. */
export interface CatalogHeader {
    /** The header's name, lowercase, as the vendor documents it. */
    name: string;
    /** The field's label key, under `settings.connectorCatalog.fields`. */
    label: string;
    pattern?: RegExp;
    secret: boolean;
}

interface EntryBase {
    id: string;
    name: string;
    vendor: string;
    category: CatalogCategory;
    /** The mark's key for `ConnectorLogo`. */
    logo: string;
}

export interface AvailableEntry extends EntryBase {
    available: true;
    /** The server's address, or a template with one `{field}` the person fills in. */
    endpoint: string;
    /** The template's one field, when `endpoint` has one. */
    field?: { key: "shop"; label: string };
    auth: CatalogAuth;
    headers?: readonly CatalogHeader[];
    /** The vendor's address ends in "/" and the server answers only there. */
    keepTrailingSlash?: boolean;
    docs: string;
}

export type CatalogEntry = AvailableEntry;

const ADOBE_DOCS =
    "https://experienceleague.adobe.com/en/docs/cx-enterprise-agentic-tools/using/tools/mcp-servers";
const CLOUDFLARE_DOCS =
    "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/";

function adobe(id: string, name: string, endpoint: string, logo = "adobe"): AvailableEntry {
    return {
        id,
        name,
        vendor: "Adobe",
        category: "marketing",
        logo,
        available: true,
        endpoint,
        auth: "oauth",
        docs: ADOBE_DOCS
    };
}

function cloudflare(id: string, name: string, endpoint: string): AvailableEntry {
    return {
        id,
        name,
        vendor: "Cloudflare",
        category: "developer",
        logo: "cloudflare",
        available: true,
        endpoint,
        auth: "oauth_or_bearer",
        docs: CLOUDFLARE_DOCS
    };
}

export const CONNECTOR_CATALOG: readonly CatalogEntry[] = [
    {
        id: "stripe",
        name: "Stripe",
        vendor: "Stripe",
        category: "payments",
        logo: "stripe",
        available: true,
        endpoint: "https://mcp.stripe.com",
        auth: "oauth_or_bearer",
        docs: "https://docs.stripe.com/mcp"
    },
    {
        id: "binance",
        name: "Binance",
        vendor: "Binance",
        category: "finance",
        logo: "binance",
        available: true,
        endpoint: "https://agent.binance.com/mcp/agentic",
        auth: "oauth",
        docs: "https://developers.binance.com/en/docs/agent-native/mcp-server/agentic"
    },
    cloudflare("cloudflare-api", "Cloudflare API", "https://mcp.cloudflare.com/mcp"),
    cloudflare("cloudflare-docs", "Cloudflare Docs", "https://docs.mcp.cloudflare.com/mcp"),
    cloudflare(
        "cloudflare-containers",
        "Cloudflare Containers",
        "https://containers.mcp.cloudflare.com/mcp"
    ),
    cloudflare(
        "cloudflare-browser",
        "Cloudflare Browser",
        "https://browser.mcp.cloudflare.com/mcp"
    ),
    {
        id: "shopify-storefront",
        name: "Shopify Storefront",
        vendor: "Shopify",
        category: "commerce",
        logo: "shopify",
        available: true,
        endpoint: "https://{shop}/api/mcp",
        field: { key: "shop", label: "shop" },
        auth: "none",
        docs: "https://shopify.dev/docs/apps/build/storefront-mcp"
    },
    {
        id: "booking",
        name: "Booking.com",
        vendor: "Booking.com",
        category: "travel",
        logo: "booking",
        available: true,
        endpoint: "https://demandapi-mcp.booking.com/v1/sp/mcp/",
        keepTrailingSlash: true,
        auth: "headers",
        headers: [
            {
                name: "x-booking-affiliate-id",
                label: "affiliateId",
                pattern: /^\d{1,20}$/,
                secret: false
            },
            { name: "x-booking-authorization", label: "demandKey", secret: true }
        ],
        docs: "https://developers.booking.com/mcp-server/docs/get-started"
    },
    adobe("adobe-journey-optimizer", "Adobe Journey Optimizer", "https://ajo-mcp.adobe.io/mcp"),
    adobe(
        "adobe-customer-journey-analytics",
        "Adobe Customer Journey Analytics",
        "https://cja-mcp.adobe.io/mcp"
    ),
    adobe("adobe-analytics", "Adobe Analytics", "https://aa-mcp.adobe.io/mcp"),
    adobe("adobe-target", "Adobe Target", "https://targetmcp.adobe.io/mcp"),
    adobe("adobe-rtcdp", "Adobe Real-Time CDP", "https://rtcdp-mcp.adobe.io/mcp"),
    adobe(
        "adobe-experience-manager",
        "Adobe Experience Manager",
        "https://mcp.adobeaemcloud.com/adobe/mcp/aem"
    ),
    adobe("adobe-marketo", "Adobe Marketo Engage", "https://marketo-mcp.adobe.io/mcp", "marketo")
];

export function catalogEntry(id: string | null | undefined): CatalogEntry | null {
    return CONNECTOR_CATALOG.find((entry) => entry.id === id) ?? null;
}

/**
 * A store's own address as Shopify serves Storefront MCP on it: a bare
 * hostname (`name.myshopify.com` or the store's own domain), lowercase, with
 * at least one dot and no scheme, port, path or credentials.
 */
export const shopDomainSchema = z
    .string()
    .trim()
    .toLowerCase()
    .transform((value) => value.replace(/^https?:\/\//, "").replace(/\/+$/, ""))
    .pipe(
        z
            .string()
            .max(253)
            .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "shop")
    );

/** The address an entry connects to, with its one field filled in; null when it cannot be. */
export function catalogUrl(entry: AvailableEntry, field?: string | null): string | null {
    if (!entry.field) return entry.endpoint;
    const shop = shopDomainSchema.safeParse(field ?? "");
    return shop.success ? entry.endpoint.replace(`{${entry.field.key}}`, shop.data) : null;
}

/** The host the allowlist is checked against, before the person types anything. */
export function catalogHost(entry: AvailableEntry): string | null {
    if (entry.field) return null;
    try {
        return new URL(entry.endpoint).hostname;
    } catch {
        return null;
    }
}

/**
 * Whether a typed address is this entry's: the fixed address itself, or the
 * template filled with a valid store. The trailing slash is not part of the
 * comparison - canonical addresses drop it.
 */
export function urlMatchesEntry(entry: AvailableEntry, url: string): boolean {
    const bare = (text: string) => text.trim().replace(/\/+$/, "").toLowerCase();
    if (!entry.field) return bare(url) === bare(entry.endpoint);
    let parsed: URL;
    try {
        parsed = new URL(url.trim());
    } catch {
        return false;
    }
    const filled = catalogUrl(entry, parsed.hostname);
    return filled !== null && bare(url) === bare(filled);
}

/** The catalog entry a stored connector was added from, by its address. */
export function entryForUrl(url: string): AvailableEntry | null {
    for (const entry of CONNECTOR_CATALOG) {
        if (entry.available && urlMatchesEntry(entry, url)) return entry;
    }
    return null;
}
