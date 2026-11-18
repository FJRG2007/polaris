/**
 * The connections table's toolbar: search, filters and sort over keys, agent
 * accounts, agents signed in on the sessions' machine and the deployment's keys.
 */

import { describe, expect, it } from "vitest";
import {
    arrangeConnections,
    isNarrowed,
    NO_FILTERS,
    type ConnectionEntry
} from "@/components/model-keys/connection-rows";

const entry = (id: string, over: Partial<ConnectionEntry>): ConnectionEntry => ({
    id,
    kind: "key",
    provider: "openai",
    providerName: "OpenAI",
    name: id,
    status: "working",
    lastUsedAt: null,
    position: 0,
    ...over
});

const rows = [
    entry("held", { kind: "deployment", provider: "groq", providerName: "Groq", position: 4 }),
    entry("Work key", { position: 0 }),
    entry("Claude plan", { kind: "account", provider: "claude", providerName: "Anthropic", position: 1, status: "off" }),
    entry("Cursor", { kind: "agent", provider: "cursor", providerName: "Cursor", position: 2, status: "problem" }),
    entry("Zed key", { provider: "groq", providerName: "Groq", position: 3, lastUsedAt: "2026-11-01T00:00:00Z" })
];
const PRIORITY = { order: "priority", direction: "asc" } as const;

describe("arrangeConnections", () => {
    it("keeps the stored order, with the deployment's keys last", () => {
        expect(arrangeConnections(rows, NO_FILTERS, PRIORITY).map((one) => one.id)).toEqual([
            "Work key",
            "Claude plan",
            "Cursor",
            "Zed key",
            "held"
        ]);
    });

    it("keeps the deployment's keys last whatever the sort", () => {
        const sorted = arrangeConnections(rows, NO_FILTERS, { order: "name", direction: "desc" });
        expect(sorted.map((one) => one.id)).toEqual(["Zed key", "Work key", "Cursor", "Claude plan", "held"]);
    });

    it("searches the name and the provider, accents aside", () => {
        expect(arrangeConnections(rows, { ...NO_FILTERS, query: "anthropíc" }, PRIORITY).map((one) => one.id)).toEqual([
            "Claude plan"
        ]);
    });

    it("filters by provider, kind and status", () => {
        expect(arrangeConnections(rows, { ...NO_FILTERS, provider: "groq" }, PRIORITY)).toHaveLength(2);
        expect(arrangeConnections(rows, { ...NO_FILTERS, kind: "agent" }, PRIORITY).map((one) => one.id)).toEqual(["Cursor"]);
        expect(arrangeConnections(rows, { ...NO_FILTERS, status: "problem" }, PRIORITY).map((one) => one.id)).toEqual([
            "Cursor"
        ]);
    });

    it("says when the table is narrowed, which is when it cannot be reordered", () => {
        expect(isNarrowed(NO_FILTERS)).toBe(false);
        expect(isNarrowed({ ...NO_FILTERS, query: " " })).toBe(false);
        expect(isNarrowed({ ...NO_FILTERS, kind: "key" })).toBe(true);
    });
});
