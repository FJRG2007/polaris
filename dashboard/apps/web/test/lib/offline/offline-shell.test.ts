/**
 * The pages kept for offline use that belong to an app behind the PIN are the
 * ones the page drops, so the lock cannot be walked around with no network.
 */

import { describe, expect, it } from "vitest";
import { lockedKeptPaths } from "@/lib/offline/offline-shell";

describe("lockedKeptPaths", () => {
    const kept = ["/notes", "/notes/n1", "/tasks", "/account/security", "/admin/apps", "/chat/c/1"];

    it("names only the pages of a locked app", () => {
        expect(lockedKeptPaths(kept, ["notes"])).toEqual(["/notes", "/notes/n1"]);
        expect(lockedKeptPaths(kept, ["notes", "chat"])).toEqual(["/notes", "/notes/n1", "/chat/c/1"]);
    });

    it("names nothing with no locks, and never the account or Settings", () => {
        expect(lockedKeptPaths(kept, [])).toEqual([]);
        expect(lockedKeptPaths(kept, ["account", "admin"])).toEqual([]);
    });
});
