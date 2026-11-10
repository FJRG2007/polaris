/**
 * The long lists in Analytics page by a keyset cursor over the ranking, the site
 * list pages by label, the sections live on routes the rail links at, and the
 * "add a website" form refuses the same things on both sides.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/setting-store", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));

import { externalSiteOwner } from "@/lib/analytics-service";
import { decodeCursor, encodeCursor, pageRanked, pageSites, type SiteListRow } from "@/lib/analytics-lists";
import {
    analyticsTabPath,
    isReportTab,
    parseSiteCookie
} from "@/app/(app)/analytics/analytics-tabs";
import { bareHost, externalSiteSchema, trackerSnippet, TRACKER_FRAMEWORKS } from "@/app/(app)/analytics/site-input";

const rows = Array.from({ length: 120 }, (_, index) => ({
    key: `/page-${String(index).padStart(3, "0")}`,
    // Ties on purpose: every pair shares visitors, half share views too.
    visitors: 200 - Math.floor(index / 2),
    views: 500 - Math.floor(index / 4)
}));

describe("ranked pages", () => {
    it("walks the whole ranking once, in order, with no repeats", () => {
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
            const page = pageRanked(rows, cursor, 50);
            seen.push(...page.rows.map((row) => row.key));
            cursor = page.next;
            pages += 1;
        } while (cursor && pages < 10);
        expect(pages).toBe(3);
        expect(new Set(seen).size).toBe(rows.length);
        expect(seen).toEqual([...rows].sort((a, b) => b.visitors - a.visitors || b.views - a.views || (a.key < b.key ? -1 : 1)).map((row) => row.key));
    });

    it("does not repeat a row that moved up between two pages", () => {
        const first = pageRanked(rows, null, 10);
        const changed = rows.map((row) => (row.key === first.rows[3]!.key ? { ...row, visitors: 1 } : row));
        const second = pageRanked(changed, first.next, 10);
        expect(second.rows.map((row) => row.key)).not.toContain(first.rows[3]!.key);
        expect(second.rows[0]!.key).toBe(rows[10]!.key);
    });

    it("treats a cursor it did not write as the top of the list", () => {
        expect(decodeCursor("not a cursor")).toBeNull();
        expect(decodeCursor(Buffer.from("[1,\"x\"]").toString("base64url"))).toBeNull();
        expect(pageRanked(rows, "garbage", 5).rows[0]!.key).toBe(rows[0]!.key);
        const cursor = encodeCursor({ visitors: 3, views: 4, key: "/a" });
        expect(decodeCursor(cursor)).toEqual({ visitors: 3, views: 4, key: "/a" });
    });

    it("ends with no cursor, and an empty ranking is one empty page", () => {
        expect(pageRanked(rows.slice(0, 3), null, 50).next).toBeNull();
        expect(pageRanked([], null)).toEqual({ rows: [], next: null });
    });
});

describe("site pages", () => {
    const sites: SiteListRow[] = Array.from({ length: 70 }, (_, index) => ({
        id: `id-${index}`,
        label: index % 2 ? `Blog ${index}` : `Shop ${index}`,
        scope: index % 3 ? "application" : "external"
    }));

    it("pages by label and id without gaps", () => {
        const first = pageSites(sites, { limit: 30 });
        const second = pageSites(sites, { limit: 30, cursor: first.next });
        const third = pageSites(sites, { limit: 30, cursor: second.next });
        const all = [...first.rows, ...second.rows, ...third.rows];
        expect(all).toHaveLength(70);
        expect(new Set(all.map((site) => site.id)).size).toBe(70);
        expect(third.next).toBeNull();
    });

    it("narrows by a search, case-insensitively", () => {
        const page = pageSites(sites, { query: "  BLOG " });
        expect(page.rows.length).toBe(35);
        expect(page.rows.every((site) => site.label.startsWith("Blog"))).toBe(true);
    });
});

describe("sections and the remembered site", () => {
    it("routes every section, reports sharing one route", () => {
        expect(analyticsTabPath("overview")).toBe("/analytics");
        expect(analyticsTabPath("geography")).toBe("/analytics/geography");
        expect(analyticsTabPath("site")).toBe("/analytics/settings");
        expect(analyticsTabPath("funnels")).toBe("/analytics/reports");
        expect(isReportTab("retention")).toBe(true);
        expect(isReportTab("sessions")).toBe(false);
    });

    it("reads back only a well-formed cookie", () => {
        expect(parseSiteCookie("external:0192f0aa-0000-7000-8000-0000000000d1:a1b2c3d4e5f6")).toEqual({
            scope: "external",
            id: "0192f0aa-0000-7000-8000-0000000000d1:a1b2c3d4e5f6"
        });
        expect(parseSiteCookie("polaris:")).toEqual({ scope: "polaris", id: "" });
        expect(parseSiteCookie("other:x")).toBeNull();
        expect(parseSiteCookie("application:<script>")).toBeNull();
        expect(parseSiteCookie(undefined)).toBeNull();
    });
});

describe("adding a website", () => {
    it("reduces what is typed to the bare host", () => {
        expect(bareHost(" HTTPS://Example.com:8080/blog?x=1 ")).toBe("example.com");
        expect(bareHost("shop.example.co.uk.")).toBe("shop.example.co.uk");
    });

    it("accepts a name and a domain, and refuses what is not one", () => {
        expect(externalSiteSchema.parse({ name: " My blog ", hostname: "https://blog.example.com/" })).toEqual({
            name: "My blog",
            hostname: "blog.example.com"
        });
        expect(externalSiteSchema.safeParse({ name: "", hostname: "example.com" }).success).toBe(false);
        expect(externalSiteSchema.safeParse({ name: "x", hostname: "localhost" }).success).toBe(false);
        expect(externalSiteSchema.safeParse({ name: "x", hostname: "not a host" }).success).toBe(false);
        expect(externalSiteSchema.safeParse({ name: "x", hostname: "-bad.example.com" }).success).toBe(false);
    });

    it("writes the same script and key for every kind of project", () => {
        for (const framework of TRACKER_FRAMEWORKS) {
            const snippet = trackerSnippet(framework, "https://polaris.example", "abc123");
            expect(snippet).toContain("https://polaris.example/analytics.js");
            expect(snippet).toContain("abc123");
        }
    });

    it("names the owner of a site added from elsewhere, and nothing else", () => {
        const owner = "0192f0aa-0000-7000-8000-0000000000d1";
        expect(externalSiteOwner(`${owner}:a1b2c3d4e5f6`)).toBe(owner);
        expect(externalSiteOwner(owner)).toBeNull();
        expect(externalSiteOwner(`${owner}:zz`)).toBeNull();
        expect(externalSiteOwner("")).toBeNull();
    });
});
