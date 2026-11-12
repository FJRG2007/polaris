import { describe, expect, it } from "vitest";
import * as store from "../../src/lib/host-store";
import type { HostState, HostStorage } from "../../src/lib/host-store";
import { HOST_LIST_MAX, HOST_NAME_MAX, readHostList } from "@polaris/core";

function memory(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    const storage: HostStorage = {
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => void data.set(key, value),
        removeItem: (key) => void data.delete(key)
    };
    return { data, storage };
}

describe("the address schema", () => {
    it("normalizes what is typed to an origin", () => {
        expect(store.parseHostAddress("  polaris.home.lan ")).toBe("https://polaris.home.lan");
        expect(store.parseHostAddress("http://192.168.1.10:3000/")).toBe("http://192.168.1.10:3000");
        expect(store.parseHostAddress("HTTPS://Polaris.Home.Lan")).toBe("https://polaris.home.lan");
    });

    it("refuses anything but a bare http(s) origin", () => {
        for (const typed of [
            "",
            "   ",
            "ftp://polaris.home.lan",
            "javascript:alert(1)",
            "https://user:pass@polaris.home.lan",
            "https://polaris.home.lan/path",
            "https://polaris.home.lan#x",
            "polaris home",
            `${"a".repeat(250)}.lan`
        ])
            expect(store.parseHostAddress(typed), typed).toBeNull();
    });
});

describe("saving several hosts", () => {
    it("adds, names, picks and removes, keeping the one in use valid", () => {
        let state: HostState = { hosts: [], active: null };
        const first = store.addHost(state, "polaris.home.lan", "  Home   lab ");
        if (!first.ok) throw new Error("not added");
        state = first.state;
        expect(state).toEqual({
            hosts: [{ origin: "https://polaris.home.lan", name: "Home lab" }],
            active: "https://polaris.home.lan"
        });
        const second = store.addHost(state, "http://10.0.0.5:3000", "");
        if (!second.ok) throw new Error("not added");
        state = second.state;
        expect(state.active).toBe("http://10.0.0.5:3000");
        expect(store.hostLabel(state.hosts[1]!)).toBe("http://10.0.0.5:3000");
        expect(store.hostLabel({ origin: "https://a.lan", name: null })).toBe("a.lan");

        expect(store.addHost(state, "https://polaris.home.lan/", "")).toEqual({
            ok: false,
            reason: "duplicate"
        });
        expect(store.addHost(state, "not an address", "")).toEqual({
            ok: false,
            reason: "invalid"
        });

        state = store.pickHost(state, "https://polaris.home.lan");
        expect(state.active).toBe("https://polaris.home.lan");
        expect(store.pickHost(state, "https://unknown.lan")).toBe(state);
        expect(store.pickHost(state, null).active).toBeNull();

        state = store.renameHost(state, "https://polaris.home.lan", "x".repeat(HOST_NAME_MAX + 5));
        expect(state.hosts[0]!.name).toBe("Home lab");
        state = store.renameHost(state, "https://polaris.home.lan", "  ");
        expect(state.hosts[0]!.name).toBeNull();

        state = store.removeHost(state, "https://polaris.home.lan");
        expect(state).toEqual({
            hosts: [{ origin: "http://10.0.0.5:3000", name: null }],
            active: "http://10.0.0.5:3000"
        });
        expect(store.removeHost(state, "http://10.0.0.5:3000")).toEqual({ hosts: [], active: null });
    });

    it("stops at the list's cap", () => {
        const hosts = Array.from({ length: HOST_LIST_MAX }, (_, at) => ({
            origin: `https://h${at}.lan`,
            name: null
        }));
        expect(store.addHost({ hosts, active: null }, "https://one-more.lan", "")).toEqual({
            ok: false,
            reason: "full"
        });
    });
});

describe("storage", () => {
    it("round-trips through the shared host-list file form", () => {
        const { data, storage } = memory();
        const state: HostState = {
            hosts: [
                { origin: "https://polaris.home.lan", name: "Home" },
                { origin: "http://10.0.0.5:3000", name: null }
            ],
            active: "http://10.0.0.5:3000"
        };
        store.saveHosts(storage, state);
        expect(readHostList(data.get(store.HOSTS_KEY)!)).toEqual(state.hosts);
        expect(data.get(store.ACTIVE_KEY)).toBe("http://10.0.0.5:3000");
        expect(store.loadHosts(storage)).toEqual(state);
        store.saveHosts(storage, { hosts: [], active: null });
        expect(data.size).toBe(0);
    });

    it("moves the single address an earlier version saved into the list, in use", () => {
        const { data, storage } = memory({ [store.LEGACY_KEY]: "https://polaris.home.lan" });
        const state = store.loadHosts(storage);
        expect(state).toEqual({
            hosts: [{ origin: "https://polaris.home.lan", name: null }],
            active: "https://polaris.home.lan"
        });
        store.saveHosts(storage, state);
        expect(data.has(store.LEGACY_KEY)).toBe(false);
        expect(store.loadHosts(storage)).toEqual(state);
    });

    it("keeps a list already saved when the old address is still there", () => {
        const { storage } = memory();
        const saved = { hosts: [{ origin: "https://a.lan", name: "A" }], active: "https://b.lan" };
        store.saveHosts(storage, { hosts: saved.hosts, active: "https://a.lan" });
        storage.setItem(store.LEGACY_KEY, "https://b.lan");
        expect(store.loadHosts(storage)).toEqual({
            hosts: [...saved.hosts, { origin: "https://b.lan", name: null }],
            active: "https://a.lan"
        });
    });

    it("reads damaged or hostile data as nothing saved", () => {
        const damaged = memory({
            [store.HOSTS_KEY]: "{not json",
            [store.ACTIVE_KEY]: "https://x.lan",
            [store.LEGACY_KEY]: "javascript:alert(1)"
        });
        expect(store.loadHosts(damaged.storage)).toEqual({ hosts: [], active: null });
        const hostile = JSON.stringify({
            kind: "polaris-hosts",
            version: 1,
            hosts: [{ origin: "javascript:alert(1)" }, { origin: "https://ok.lan/" }]
        });
        const read = memory({ [store.HOSTS_KEY]: hostile, [store.ACTIVE_KEY]: "javascript:alert(1)" });
        expect(store.loadHosts(read.storage)).toEqual({
            hosts: [{ origin: "https://ok.lan", name: null }],
            active: null
        });
    });
});
