// @vitest-environment jsdom
/**
 * The browser side of changing account: what one account leaves behind is gone
 * before another is drawn, and every other tab follows.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dropped = { snapshots: 0, mail: 0 };
vi.mock("@/lib/snapshot-cache", () => ({ dropAllSnapshots: () => void (dropped.snapshots += 1) }));
vi.mock("@/lib/mailbox/mail-cache", () => ({ dropMailCache: async () => void (dropped.mail += 1) }));

const { ACCOUNT_MARKER_KEY, forgetAccountTraces, leaveAccount, listenForAccountChange, reconcileAccount } =
    await import("@/lib/account-switch");

const assign = vi.fn();

/** A storage of its own: the test environment's may be missing or shared. */
function memoryStorage(): Storage {
    const items = new Map<string, string>();
    return {
        get length() {
            return items.size;
        },
        key: (index: number) => Array.from(items.keys())[index] ?? null,
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, String(value)),
        removeItem: (key: string) => void items.delete(key),
        clear: () => items.clear()
    };
}

function storedKeys(): string[] {
    return Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index) ?? "");
}

beforeEach(() => {
    Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
    dropped.snapshots = 0;
    dropped.mail = 0;
    assign.mockReset();
    Object.defineProperty(window, "location", { value: { ...window.location, assign }, configurable: true });
});

function seedTraces(): void {
    window.localStorage.setItem("polaris.overview.recent", "[\"A's plan\"]");
    window.localStorage.setItem("polaris.search.recent", "[\"salary\"]");
    window.localStorage.setItem("polaris.place.drive", "/drive/f/ana");
    window.localStorage.setItem("polaris.apps.usage", "{}");
    window.localStorage.setItem("polaris.mail.announced", "x");
    window.localStorage.setItem("polaris.theme", "dark");
}

describe("forgetAccountTraces", () => {
    it("clears what was kept for the account and nothing that belongs to the device", async () => {
        seedTraces();
        await forgetAccountTraces();
        expect(storedKeys()).toEqual(["polaris.theme"]);
        expect(dropped).toEqual({ snapshots: 1, mail: 1 });
    });
});

describe("reconcileAccount", () => {
    it("records the first account without clearing anything", () => {
        seedTraces();
        reconcileAccount("ana");
        expect(window.localStorage.getItem(ACCOUNT_MARKER_KEY)).toBe("ana");
        expect(window.localStorage.getItem("polaris.overview.recent")).not.toBeNull();
    });

    it("clears the previous account's traces when the page is drawn for another", async () => {
        reconcileAccount("ana");
        seedTraces();
        reconcileAccount("ben");
        expect(window.localStorage.getItem(ACCOUNT_MARKER_KEY)).toBe("ben");
        expect(window.localStorage.getItem("polaris.overview.recent")).toBeNull();
        expect(window.localStorage.getItem("polaris.search.recent")).toBeNull();
    });
});

describe("listenForAccountChange", () => {
    it("reloads this tab when another tab is drawn for a different account", () => {
        const stop = listenForAccountChange("ana");
        window.dispatchEvent(new StorageEvent("storage", { key: ACCOUNT_MARKER_KEY, newValue: "ana" }));
        expect(assign).not.toHaveBeenCalled();
        window.dispatchEvent(new StorageEvent("storage", { key: "polaris.theme", newValue: "light" }));
        expect(assign).not.toHaveBeenCalled();
        window.dispatchEvent(new StorageEvent("storage", { key: ACCOUNT_MARKER_KEY, newValue: "ben" }));
        expect(assign).toHaveBeenCalledWith("/");
        expect(dropped.snapshots).toBe(1);
        stop();
    });

    it("reloads when another tab signs out", () => {
        const stop = listenForAccountChange("ana");
        window.dispatchEvent(new StorageEvent("storage", { key: ACCOUNT_MARKER_KEY, newValue: "" }));
        expect(assign).toHaveBeenCalledWith("/");
        stop();
    });

    it("stops listening when cleaned up", () => {
        listenForAccountChange("ana")();
        window.dispatchEvent(new StorageEvent("storage", { key: ACCOUNT_MARKER_KEY, newValue: "ben" }));
        expect(assign).not.toHaveBeenCalled();
    });
});

describe("leaveAccount", () => {
    it("forgets the account, tells the other tabs, and loads the target fresh", async () => {
        reconcileAccount("ana");
        seedTraces();
        await leaveAccount("/oauth/login");
        expect(window.localStorage.getItem(ACCOUNT_MARKER_KEY)).toBe("");
        expect(window.localStorage.getItem("polaris.place.drive")).toBeNull();
        expect(assign).toHaveBeenCalledWith("/oauth/login");
    });
});
