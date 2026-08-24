/**
 * Who a FiveM server lets in, and what the door is actually handed.
 *
 * FiveM has no whitelist and no ban list, so both are Polaris' own and are
 * enforced by a resource it writes into the server. That makes two things worth
 * pinning down here rather than trusting to the screen that renders them.
 *
 * The first is that "added" and "the server knows" are separate states. A server
 * that was created a minute ago is still starting and can be told nothing at all,
 * so a player can be on the list and not yet at the door - and collapsing the two
 * is what would have a moderator adding somebody twice.
 *
 * The second is the timeout. A ban with an end on it is only a timeout if the
 * thing at the door never sees it after it has run out, and the file is built to
 * make that true by construction: an expired ban is not sent, rather than sent
 * with a date for somebody else's clock to compare.
 */

import { describe, expect, it } from "vitest";
import * as access from "@/lib/apps/fivem/access";
import { guardAccessFile } from "@/lib/apps/fivem/guard";

const ALICE = "license:0123456789abcdef0123456789abcdef01234567";
const BOB = "discord:112233445566778899";
const NOW = "2026-08-24T10:00:00.000Z";

describe("the allow list", () => {
    it("reads back what was written and drops what cannot be read", () => {
        const list = access.readAllowList({
            [access.ALLOW_LIST_KEY]: [
                { identifier: ALICE, label: "Alice", addedAt: NOW, appliedAt: null },
                { identifier: "not an identifier", label: "nobody" },
                null
            ]
        });
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ identifier: ALICE, label: "Alice", appliedAt: null });
    });

    it("is empty for an install that has never had one", () => {
        expect(access.readAllowList({})).toEqual([]);
    });

    it("does not reset what the server was told when somebody is added twice", () => {
        const first = access.withAllowed([], { identifier: ALICE, label: "Alice" }, NOW);
        const applied = first.map((entry) => ({ ...entry, appliedAt: NOW }));
        const again = access.withAllowed(applied, { identifier: ALICE, label: "Alice again" }, NOW);
        expect(again).toHaveLength(1);
        expect(again[0]?.appliedAt).toBe(NOW);
        expect(again[0]?.label).toBe("Alice again");
    });

    it("matches however the identifier was typed", () => {
        const list = access.withAllowed([], { identifier: ALICE.toUpperCase(), label: "Alice" }, NOW);
        expect(access.withoutAllowed(list, ALICE)).toEqual([]);
    });

    it("says who the server has not been handed yet", () => {
        const list = [
            { identifier: ALICE, label: "Alice", addedAt: NOW, appliedAt: NOW },
            { identifier: BOB, label: "Bob", addedAt: NOW, appliedAt: null }
        ];
        expect(access.pendingAllowed(list).map((entry) => entry.identifier)).toEqual([BOB]);
    });
});

describe("a ban", () => {
    it("replaces rather than stacks - banning again is restating it", () => {
        const once = access.withBan([], { identifier: ALICE, label: "Alice", reason: "first" }, NOW);
        const twice = access.withBan(once, { identifier: ALICE, label: "Alice", reason: "second" }, NOW);
        expect(twice).toHaveLength(1);
        expect(twice[0]?.reason).toBe("second");
    });

    it("with an end on it stops being one when it runs out", () => {
        const list = access.withBan(
            [],
            { identifier: ALICE, label: "Alice", reason: "cool off", until: "2026-08-24T10:30:00.000Z" },
            NOW
        );
        expect(access.activeBans(list, new Date("2026-08-24T10:29:00.000Z"))).toHaveLength(1);
        expect(access.activeBans(list, new Date("2026-08-24T10:31:00.000Z"))).toHaveLength(0);
        expect(access.expiredBans(list, new Date("2026-08-24T10:31:00.000Z"))).toHaveLength(1);
    });

    it("without an end never lifts by itself", () => {
        const list = access.withBan([], { identifier: ALICE, label: "Alice", reason: "" }, NOW);
        expect(access.activeBans(list, new Date("2030-01-01T00:00:00.000Z"))).toHaveLength(1);
    });

    it("carries a reason that survives the trip to the game", () => {
        expect(access.isBanReason("Griefing")).toBe(true);
        expect(access.isBanReason("x".repeat(access.MAX_BAN_REASON + 1))).toBe(false);
        expect(access.isBanReason("two\nlines")).toBe(false);
        // The console tokenizer has no escape inside a quoted run, so half of this
        // would silently disappear on the way.
        expect(access.isBanReason('called me a "name"')).toBe(false);
    });
});

describe("the administrators", () => {
    it("become the config lines the game reads, with quit held back", () => {
        const lines = access.adminCfgLines([{ identifier: ALICE, label: "Alice", addedAt: NOW }]);
        expect(lines).toContain("add_ace group.admin command allow");
        expect(lines).toContain("add_ace group.admin command.quit deny");
        expect(lines).toContain(`add_principal identifier.${ALICE} group.admin`);
    });

    it("write the group even when nobody is in it, which is the honest state", () => {
        expect(access.adminCfgLines([])).toHaveLength(2);
    });
});

describe("the file the door reads", () => {
    it("carries only what a decision at the door needs", () => {
        const file = guardAccessFile(
            {
                allowList: [{ identifier: ALICE, label: "Alice", addedAt: NOW, appliedAt: NOW }],
                bans: [{ identifier: BOB, label: "Bob", reason: "Griefing", at: NOW, until: null }],
                admins: [{ identifier: ALICE, label: "Alice", addedAt: NOW }],
                exclusiveJoin: true
            },
            new Date(NOW)
        );
        expect(file.exclusiveJoin).toBe(true);
        expect(file.allowList).toEqual([{ identifier: ALICE }]);
        expect(file.bans).toEqual([{ identifier: BOB, reason: "Griefing" }]);
        // No labels, no dates, no admin list: none of it is a decision at the door.
        expect(JSON.stringify(file)).not.toContain("Alice");
    });

    it("leaves an expired ban out rather than sending a date for another clock to compare", () => {
        const file = guardAccessFile(
            {
                allowList: [],
                bans: [{ identifier: BOB, label: "Bob", reason: "cool off", at: NOW, until: NOW }],
                admins: [],
                exclusiveJoin: false
            },
            new Date("2026-08-24T11:00:00.000Z")
        );
        expect(file.bans).toEqual([]);
    });

    it("gives a ban with no reason something the player can read", () => {
        const file = guardAccessFile(
            {
                allowList: [],
                bans: [{ identifier: BOB, label: "Bob", reason: "", at: NOW, until: null }],
                admins: [],
                exclusiveJoin: false
            },
            new Date(NOW)
        );
        expect(file.bans[0]?.reason).toBe(access.DEFAULT_BAN_REASON);
    });
});

describe("the console password", () => {
    it("is long enough to be a credential and made of what a person can retype", () => {
        const password = access.generateConsolePassword((size) => new Uint8Array(size).fill(7));
        expect(password).toHaveLength(access.CONSOLE_PASSWORD_LENGTH);
        expect(access.isConsolePassword(password)).toBe(true);
    });

    it("refuses one that is too short or carries anything but letters and digits", () => {
        expect(access.isConsolePassword("short")).toBe(false);
        expect(access.isConsolePassword("has a space in it")).toBe(false);
        expect(access.isConsolePassword("a".repeat(65))).toBe(false);
    });
});

describe("a closed server", () => {
    it("is what an install is unless somebody deliberately opened it", () => {
        expect(access.readExclusiveJoin({})).toBe(true);
        expect(access.readExclusiveJoin({ [access.EXCLUSIVE_JOIN_KEY]: false })).toBe(false);
    });
});
