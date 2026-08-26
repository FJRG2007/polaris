/**
 * Finding one key in a list of fourteen.
 *
 * The filters are what make a long key list usable, and the two rules inside
 * them are the sort that go wrong quietly: whether a key counts as expiring soon
 * (an expired one has already gone, and is not "soon"), and where a key that has
 * never been used belongs when the list is sorted by last use (last, because an
 * empty value is not "a very long time ago").
 */

import { describe, expect, it } from "vitest";
import type { ApiKeyView } from "@polaris/auth";
import * as list from "@/app/(app)/account/api-keys/api-keys-filter";

const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function key(over: Partial<ApiKeyView> = {}): ApiKeyView {
    return {
        id: "00000000-0000-0000-0000-000000000001",
        name: "Backup script",
        description: "",
        environment: "production",
        prefix: "plk_abc123",
        tail: "9f3c",
        scopes: ["drive.read"],
        allowedCidrs: [],
        allowedCountries: [],
        allowedContinents: [],
        allowedUserAgents: [],
        deniedUserAgents: [],
        groupIds: [],
        expiresAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        lastUsedUserAgent: null,
        revokedAt: null,
        createdAt: new Date(NOW - 30 * DAY).toISOString(),
        projectId: null,
        projectName: null,
        usedToday: 0,
        usedRecently: 0,
        ...over
    };
}

describe("what state a key is in", () => {
    it("is revoked before it is anything else", () => {
        const revoked = key({
            revokedAt: new Date(NOW - DAY).toISOString(),
            expiresAt: new Date(NOW - 2 * DAY).toISOString()
        });
        expect(list.lifecycleOf(revoked, NOW)).toBe("revoked");
    });

    it("is expired once the moment has passed", () => {
        expect(list.lifecycleOf(key({ expiresAt: new Date(NOW - 1).toISOString() }), NOW)).toBe(
            "expired"
        );
        expect(list.lifecycleOf(key({ expiresAt: new Date(NOW + DAY).toISOString() }), NOW)).toBe(
            "active"
        );
    });

    it("counts as expiring soon only while it still works", () => {
        expect(list.expiringSoon(key({ expiresAt: new Date(NOW + 2 * DAY).toISOString() }), NOW)).toBe(
            true
        );
        expect(list.expiringSoon(key({ expiresAt: new Date(NOW + 30 * DAY).toISOString() }), NOW)).toBe(
            false
        );
        // Already gone. "Expiring in 7 days" is a warning, and a key that has
        // expired is past being warned about.
        expect(list.expiringSoon(key({ expiresAt: new Date(NOW - DAY).toISOString() }), NOW)).toBe(
            false
        );
        expect(list.expiringSoon(key(), NOW)).toBe(false);
    });
});

describe("what a key looks like in the list", () => {
    it("shows the end, which is the half a person can recognise", () => {
        // Not the eight random characters of the public half: they identify the
        // row to Polaris and nothing to somebody reading a table.
        expect(list.maskedKey(key())).toBe("plk_...9f3c");
    });

    it("shows what it has for a key issued before the tail was kept", () => {
        expect(list.maskedKey(key({ tail: null }))).toBe("plk_abc123...");
    });

    it("still finds a key by the public half that is no longer drawn", () => {
        const keys = [key({ id: "a" }), key({ id: "b", prefix: "plk_zzz999", tail: "0000" })];
        expect(
            list.filterKeys(keys, { ...list.NO_FILTERS, search: "abc123" }, NOW).map((r) => r.id)
        ).toEqual(["a"]);
    });
});

describe("narrowing the list", () => {
    const keys = [
        key({ id: "a", name: "Deploy token", environment: "production", usedToday: 4 }),
        key({ id: "b", name: "Laptop trial", environment: "development", tail: "1234" }),
        key({
            id: "c",
            name: "Old importer",
            expiresAt: new Date(NOW - DAY).toISOString(),
            projectId: "app-1",
            projectName: "Shop"
        })
    ];

    it("searches what the key is for as well as what it is called", () => {
        const described = [
            key({ id: "a", name: "CI", description: "Uploads the nightly build" }),
            key({ id: "b", name: "Laptop" })
        ];
        expect(
            list.filterKeys(described, { ...list.NO_FILTERS, search: "nightly" }, NOW).map((r) => r.id)
        ).toEqual(["a"]);
    });

    it("searches the name and the visible halves of the key", () => {
        const found = list.filterKeys(keys, { ...list.NO_FILTERS, search: "1234" }, NOW);
        expect(found.map((row) => row.id)).toEqual(["b"]);
        expect(
            list.filterKeys(keys, { ...list.NO_FILTERS, search: "deploy" }, NOW).map((r) => r.id)
        ).toEqual(["a"]);
    });

    it("filters by environment, by app and by expiry", () => {
        expect(
            list
                .filterKeys(keys, { ...list.NO_FILTERS, environment: "development" }, NOW)
                .map((row) => row.id)
        ).toEqual(["b"]);
        expect(
            list.filterKeys(keys, { ...list.NO_FILTERS, app: "app-1" }, NOW).map((row) => row.id)
        ).toEqual(["c"]);
        expect(
            list.filterKeys(keys, { ...list.NO_FILTERS, app: "none" }, NOW).map((row) => row.id)
        ).toEqual(["a", "b"]);
        expect(
            list.filterKeys(keys, { ...list.NO_FILTERS, expiry: "expired" }, NOW).map((r) => r.id)
        ).toEqual(["c"]);
        expect(
            list.filterKeys(keys, { ...list.NO_FILTERS, expiry: "never" }, NOW).map((r) => r.id)
        ).toEqual(["a", "b"]);
    });

    it("only offers the apps that keys were actually minted from", () => {
        expect(list.appsInKeys(keys)).toEqual([{ id: "app-1", name: "Shop" }]);
    });

    it("sorts a key that has never been used last, not first", () => {
        const used = [
            key({ id: "never", lastUsedAt: null }),
            key({ id: "april", lastUsedAt: new Date(NOW - 120 * DAY).toISOString() }),
            key({ id: "today", lastUsedAt: new Date(NOW - 60_000).toISOString() })
        ];
        expect(
            list.filterKeys(used, { ...list.NO_FILTERS, sort: "used-desc" }, NOW).map((r) => r.id)
        ).toEqual(["today", "april", "never"]);
    });

    it("sorts by what was actually called today", () => {
        expect(
            list.filterKeys(keys, { ...list.NO_FILTERS, sort: "usage-desc" }, NOW)[0]?.id
        ).toBe("a");
    });
});
