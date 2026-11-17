import { describe, expect, it } from "vitest";
import { sessionSearchQuery, sessionSearchWhere } from "@/lib/agents/session-search";

describe("sessionSearchWhere", () => {
    it("searches only the person's own sessions still in their history", () => {
        const where = sessionSearchWhere("user-1", "login");
        expect(where.startedById).toBe("user-1");
        expect(where.polarHiddenAt).toBeNull();
    });

    it("matches the title, the repository and the person's own prompts", () => {
        const where = sessionSearchWhere("user-1", "login");
        const contains = { contains: "login", mode: "insensitive" };
        expect(where.OR).toEqual([
            { title: contains },
            { repo: { repoFullName: contains } },
            { messages: { some: { role: "user", kind: "text", body: contains } } }
        ]);
    });
});

describe("sessionSearchQuery", () => {
    it("trims the words and defaults to the first page", () => {
        expect(sessionSearchQuery.parse({ q: "  fix  " })).toEqual({ q: "fix", page: 0 });
    });

    it("refuses an empty search, an endless one, and a stray parameter", () => {
        expect(sessionSearchQuery.safeParse({ q: "   " }).success).toBe(false);
        expect(sessionSearchQuery.safeParse({ q: "a".repeat(201) }).success).toBe(false);
        expect(sessionSearchQuery.safeParse({ q: "fix", page: "999" }).success).toBe(false);
        expect(sessionSearchQuery.safeParse({ q: "fix", other: "1" }).success).toBe(false);
    });
});
