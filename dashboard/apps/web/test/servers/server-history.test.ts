/**
 * A server's history, in the words somebody reads when they open a box that has
 * been misbehaving.
 */

import { describe, expect, it } from "vitest";
import type { ActivityLine } from "../../src/lib/activity/activity";
import { describeServerEvent } from "../../src/app/(app)/apps/servers/server-history";

function line(overrides: Partial<ActivityLine> = {}): ActivityLine {
    return {
        id: "l1",
        action: "renamed",
        fromValue: null,
        toValue: null,
        authorName: "Ana",
        createdAt: "2026-08-15T10:00:00.000Z",
        ...overrides
    };
}

describe("describing what happened to a server", () => {
    it("names the new name when there is one", () => {
        expect(describeServerEvent(line({ toValue: "lirio-0" }))).toBe("Ana renamed it to lirio-0");
    });

    it("still reads as a sentence when the new name was not recorded", () => {
        expect(describeServerEvent(line())).toBe("Ana renamed it");
    });

    it("says where it lives", () => {
        expect(describeServerEvent(line({ action: "environment", toValue: "datacenter" }))).toBe(
            "Ana set where it lives to datacenter"
        );
    });

    it("credits Polaris when nobody is named", () => {
        expect(describeServerEvent(line({ authorName: null, toValue: "lirio-0" }))).toBe(
            "Polaris renamed it to lirio-0"
        );
    });

    it("falls back to something true for an action it does not know", () => {
        expect(describeServerEvent(line({ action: "rebooted" }))).toBe("Ana changed it");
    });
});
