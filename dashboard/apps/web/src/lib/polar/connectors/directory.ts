/**
 * The connectors directory: the catalog and this person's connections as one
 * list, each server exactly once. A catalog entry somebody connected carries
 * that connection (or, for a template such as a Shopify store, each of them)
 * instead of being listed a second time; a server added by its address is its
 * own entry, marked custom. Claude's and ChatGPT's connector directories draw
 * it the same way.
 *
 * Pure and client-safe: the directory route searches and pages it, and the
 * settings screen draws its first page from the same function on first paint.
 */

import { z } from "zod";
import { hostAllowed } from "@/lib/polar/connectors/shared";
import type { ConnectorView } from "@/lib/polar/connectors/store";
import {
    CATALOG_CATEGORIES,
    CONNECTOR_CATALOG,
    urlMatchesEntry,
    type CatalogCategory,
    type CatalogEntry
} from "@/lib/polar/connectors/catalog";

export const DIRECTORY_VIEWS = ["all", "connected", "attention"] as const;
export type DirectoryView = (typeof DIRECTORY_VIEWS)[number];

export const DIRECTORY_CATEGORIES = [...CATALOG_CATEGORIES, "custom"] as const;
export type DirectoryCategory = CatalogCategory | "custom";

/**
 * Where an entry stands: `connected` works, `attention` is connected but needs
 * a sign-in or does not answer, `available` can be connected, `unavailable` is
 * refused by the administrator's host list.
 */
export type DirectoryState = "connected" | "attention" | "available" | "unavailable";

export interface DirectoryItem {
    /** `catalog:<entry id>` or `custom:<connection id>`. */
    key: string;
    kind: "catalog" | "custom";
    entryId: string | null;
    name: string;
    vendor: string;
    category: DirectoryCategory;
    /** The connections behind this entry, in the order they were made. */
    connectionIds: string[];
    state: DirectoryState;
}

export interface DirectoryPage {
    items: DirectoryItem[];
    /** The cursor of the next page, or null on the last one. */
    next: number | null;
    total: number;
    counts: Record<DirectoryView, number>;
}

type Connection = Pick<ConnectorView, "id" | "name" | "url" | "auth" | "signedIn" | "status">;

export const DIRECTORY_PAGE_SIZE = 24;

/** A connection that cannot be used until somebody does something about it. */
export function needsAttention(row: Pick<Connection, "auth" | "signedIn" | "status">): boolean {
    return (
        (row.auth === "oauth" && !row.signedIn) || row.status === "sign_in" || row.status === "error"
    );
}

/** The state of an entry with these connections; the worst of them wins. */
export function stateOf(
    connections: readonly Pick<Connection, "auth" | "signedIn" | "status">[],
    blocked = false
): DirectoryState {
    if (connections.length === 0) return blocked ? "unavailable" : "available";
    return connections.some(needsAttention) ? "attention" : "connected";
}

function hostOf(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}

const RANK: Record<DirectoryState, number> = {
    attention: 0,
    connected: 1,
    available: 2,
    unavailable: 3
};

/**
 * Every entry once: what needs attention first, then what is connected, then
 * the rest of the catalog in its own order.
 */
export function buildDirectory(
    rows: readonly Connection[],
    hosts: readonly string[] = [],
    catalog: readonly CatalogEntry[] = CONNECTOR_CATALOG
): DirectoryItem[] {
    const claimed = new Set<string>();
    const items: DirectoryItem[] = catalog.map((entry) => {
        const connections = rows.filter(
            (row) => !claimed.has(row.id) && urlMatchesEntry(entry, row.url)
        );
        for (const row of connections) claimed.add(row.id);
        const blocked = !entry.field && !hostAllowed(entry.endpoint, hosts);
        return {
            key: `catalog:${entry.id}`,
            kind: "catalog",
            entryId: entry.id,
            name: entry.name,
            vendor: entry.vendor,
            category: entry.category,
            connectionIds: connections.map((row) => row.id),
            state: stateOf(connections, blocked)
        };
    });
    for (const row of rows) {
        if (claimed.has(row.id)) continue;
        items.push({
            key: `custom:${row.id}`,
            kind: "custom",
            entryId: null,
            name: row.name,
            vendor: hostOf(row.url),
            category: "custom",
            connectionIds: [row.id],
            state: stateOf([row])
        });
    }
    return items
        .map((item, order) => ({ item, order }))
        .sort((a, b) => RANK[a.item.state] - RANK[b.item.state] || a.order - b.order)
        .map(({ item }) => item);
}

/** Lowercase without accents, so "cafe" finds "Café". */
export function fold(text: string): string {
    return text
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase();
}

export interface DirectoryQuery {
    q: string;
    category: DirectoryCategory | "all";
    view: DirectoryView;
}

function inView(item: DirectoryItem, view: DirectoryView): boolean {
    if (view === "connected") return item.connectionIds.length > 0;
    if (view === "attention") return item.state === "attention";
    return true;
}

/** How many entries each view holds, whatever the search. */
export function directoryCounts(items: readonly DirectoryItem[]): Record<DirectoryView, number> {
    return {
        all: items.length,
        connected: items.filter((item) => inView(item, "connected")).length,
        attention: items.filter((item) => inView(item, "attention")).length
    };
}

export function queryDirectory(
    items: readonly DirectoryItem[],
    query: DirectoryQuery
): DirectoryItem[] {
    const words = fold(query.q.trim()).split(/\s+/).filter(Boolean);
    return items.filter((item) => {
        if (!inView(item, query.view)) return false;
        if (query.category !== "all" && item.category !== query.category) return false;
        const haystack = fold(`${item.name} ${item.vendor} ${item.category}`);
        return words.every((word) => haystack.includes(word));
    });
}

/** One page of a searched directory, from `cursor` (an offset). */
export function pageDirectory(
    all: readonly DirectoryItem[],
    query: DirectoryQuery,
    cursor = 0,
    size = DIRECTORY_PAGE_SIZE
): DirectoryPage {
    const matched = queryDirectory(all, query);
    const end = cursor + size;
    return {
        items: matched.slice(cursor, end),
        next: end < matched.length ? end : null,
        total: matched.length,
        counts: directoryCounts(all)
    };
}

/** The directory route's query string. */
export const directoryQuerySchema = z.object({
    q: z.string().trim().max(100).default(""),
    category: z.enum(["all", ...DIRECTORY_CATEGORIES]).default("all"),
    view: z.enum(DIRECTORY_VIEWS).default("all"),
    cursor: z.coerce.number().int().min(0).max(100_000).default(0),
    size: z.coerce.number().int().min(1).max(60).default(DIRECTORY_PAGE_SIZE)
});
