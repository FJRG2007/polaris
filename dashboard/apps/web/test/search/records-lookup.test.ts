/**
 * Search's `/records`: answered by the installed apps that keep records, each
 * checking its own grant, and drawn as the records scope.
 */

import type { SessionUser } from "@/lib/session";
import { describe, expect, it, vi } from "vitest";

const appRecordHits = vi.fn();

vi.mock("@/lib/rich-text/mention-service", () => ({ searchMentions: vi.fn() }));
vi.mock("@/lib/session", () => ({ userHasManage: vi.fn(async () => true) }));
vi.mock("@/lib/app-extensions/registry", () => ({ appRecordHits }));

const { lookup } = await import("@/lib/search/lookup-service");

const user = { id: "0193b0f0-0000-7000-8000-000000000001", isAdmin: false } as SessionUser;

describe("searching records", () => {
    it("asks the apps for this account's records and keeps where each opens", async () => {
        appRecordHits.mockResolvedValueOnce([
            { id: "c1", label: "Example Co", detail: "Companies", href: "/crm/companies/c1" }
        ]);
        expect(await lookup(user, { scope: "records", query: "example" })).toEqual([
            {
                id: "c1",
                scope: "records",
                label: "Example Co",
                detail: "Companies",
                href: "/crm/companies/c1"
            }
        ]);
        expect(appRecordHits).toHaveBeenCalledWith(user.id, "example", 12);
    });
});
