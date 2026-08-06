/**
 * Where a scoped search sends people, and who is allowed to run one.
 *
 * The rules being protected: tasks and pages are behind the permission their own
 * screens are, so search cannot become the way to read the name of something the
 * app would refuse to open; and every match has to land somewhere real, which
 * for a person means their work, since a person has no page of their own.
 */

import type { SessionUser } from "@/lib/session";
import { beforeEach, describe, expect, it, vi } from "vitest";

const searchMentions = vi.fn();
const userHasManage = vi.fn();

vi.mock("@/lib/rich-text/mention-service", () => ({ searchMentions }));
vi.mock("@/lib/session", () => ({ userHasManage }));

const { canSearchScope, lookup } = await import("@/lib/search/lookup-service");

const user = { id: "0193b0f0-0000-7000-8000-000000000001", isAdmin: false } as SessionUser;
const id = "0193b0f0-0000-7000-8000-0000000000aa";

beforeEach(() => {
    searchMentions.mockReset();
    userHasManage.mockReset();
    userHasManage.mockResolvedValue(true);
});

describe("who may search what", () => {
    it("puts tasks and pages behind the tasks permission", async () => {
        userHasManage.mockResolvedValue(false);
        expect(await canSearchScope(user, "tasks")).toBe(false);
        expect(await canSearchScope(user, "docs")).toBe(false);
        expect(await lookup(user, { scope: "tasks", query: "release" })).toEqual([]);
        // Refused before anything is read.
        expect(searchMentions).not.toHaveBeenCalled();
    });

    it("asks nothing extra for the account's own notes, or for people", async () => {
        userHasManage.mockResolvedValue(false);
        expect(await canSearchScope(user, "notes")).toBe(true);
        expect(await canSearchScope(user, "users")).toBe(true);
    });
});

describe("where a match opens", () => {
    it("sends a person to their work, since a person has no page", async () => {
        searchMentions.mockResolvedValue([
            { kind: "user", id, label: "Ana Ruiz", detail: "ana@example.com", image: null }
        ]);
        const [hit] = await lookup(user, { scope: "users", query: "ana" });
        expect(hit?.href).toBe(`/tasks/everything?assignee=${id}`);
        expect(hit?.scope).toBe("users");
    });

    it("sends work to the address its chips already use", async () => {
        searchMentions.mockResolvedValue([
            {
                kind: "task",
                id,
                label: "Ship 2.1",
                detail: "PLR-42 in Platform",
                image: null,
                reference: "PLR-42",
                place: "Platform",
                status: { name: "In progress", color: "#3b82f6" }
            }
        ]);
        const [hit] = await lookup(user, { scope: "tasks", query: "ship" });
        expect(hit?.href).toBe(`/tasks/t/${id}`);
        // The badge and the dot are what tell a live record from a page.
        expect(hit?.reference).toBe("PLR-42");
        expect(hit?.status).toEqual({ name: "In progress", color: "#3b82f6" });
        // The badge says PLR-42 already; saying it again underneath is noise.
        expect(hit?.detail).toBe("Platform");
    });

    it("searches one kind per command, never all of them", async () => {
        searchMentions.mockResolvedValue([]);
        await lookup(user, { scope: "notes", query: "ideas" });
        expect(searchMentions).toHaveBeenCalledTimes(1);
        expect(searchMentions.mock.calls[0]?.[1]).toEqual(["note"]);
    });
});
