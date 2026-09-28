/**
 * The Overview's figures, asked for in two requests.
 *
 * The slow cards - the monitoring read behind usage and alarms, and storage -
 * go on their own, so the quick ones are not held back until they finish.
 */

import { describe, expect, it } from "vitest";
import { overviewRequestGroups } from "@/lib/overview/request-groups";

describe("overview request groups", () => {
    it("sends the slow cards apart from the quick ones", () => {
        expect(overviewRequestGroups(["activity", "alarms", "services", "storage", "tasks", "usage"])).toEqual([
            ["activity", "services", "tasks"],
            ["alarms", "storage", "usage"]
        ]);
    });

    it("sends one request when every card is on the same side", () => {
        expect(overviewRequestGroups(["sessions", "tasks"])).toEqual([["sessions", "tasks"]]);
        expect(overviewRequestGroups(["usage"])).toEqual([["usage"]]);
    });

    it("sends nothing for nothing", () => {
        expect(overviewRequestGroups([])).toEqual([]);
    });
});
