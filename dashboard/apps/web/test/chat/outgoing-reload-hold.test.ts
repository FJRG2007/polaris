// @vitest-environment jsdom

/**
 * A message whose files are still on their way, or failed and waiting for a
 * retry, keeps the tab from reloading by itself: those files exist nowhere else.
 */

import { describe, expect, it } from "vitest";
import { safeToReload } from "@/lib/reload-safety";
import { patchOutgoing, putOutgoing, type Outgoing } from "@/app/(app)/chat/outgoing";

const one: Outgoing = {
    id: "outgoing-test",
    scope: "conversation-test",
    body: "",
    files: [],
    kept: [],
    hidden: [],
    phase: "sending"
};

describe("a message on its way and the automatic reload", () => {
    it("holds the tab until the message is gone", () => {
        expect(safeToReload()).toBe(true);
        putOutgoing(one);
        expect(safeToReload()).toBe(false);
        patchOutgoing(one.id, (was) => ({ ...was, phase: "failed", error: "not sent" }));
        expect(safeToReload()).toBe(false);
        patchOutgoing(one.id, () => null);
        expect(safeToReload()).toBe(true);
    });
});
