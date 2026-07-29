/**
 * The guided setup's resume-after-reload behaviour. Three things are worth protecting:
 * a stored draft that no longer fits must be dropped rather than half-applied (it comes
 * from storage the browser can edit), the DuckDNS token must never end up in it, and a
 * domain that is already configured must be what the setup opens on - the operator who
 * saved one and reloaded should find it, not the first question over again.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerEnvironment } from "@polaris/core";
import type { DomainSetupState } from "../../src/app/(app)/admin/domains/setup-actions";
import {
    clearSetupDraft,
    configuredStrategy,
    isUntouched,
    readSetupDraft,
    savedAnswers,
    setupDraftSchema,
    writeSetupDraft,
    type SetupDraft
} from "../../src/app/(app)/admin/domains/setup-draft";

const DRAFT: SetupDraft = {
    step: 2,
    environment: "home-nat",
    strategy: "own-domain",
    baseDomain: "example.com",
    zones: [{ label: "plr", scope: "polaris", primary: true }],
    duckSub: "",
    useForDashboard: true
};

/** Minimal stand-in for the browser store; `fail` makes every call throw. */
function stubStorage(fail = false) {
    const entries = new Map<string, string>();
    const guard = () => {
        if (fail) throw new Error("storage is disabled");
    };
    (globalThis as { window?: unknown }).window = {
        localStorage: {
            getItem: (key: string) => {
                guard();
                return entries.get(key) ?? null;
            },
            setItem: (key: string, value: string) => {
                guard();
                entries.set(key, value);
            },
            removeItem: (key: string) => {
                guard();
                entries.delete(key);
            }
        }
    };
    return entries;
}

let store: Map<string, string>;

/** The key the module writes under, taken from a real write rather than repeated here. */
function storedKey(): string {
    writeSetupDraft(DRAFT);
    const key = [...store.keys()][0];
    expect(key).toBeDefined();
    return key as string;
}

beforeEach(() => {
    store = stubStorage();
});

afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
});

describe("setup draft", () => {
    it("gives back exactly what was left unfinished", () => {
        writeSetupDraft(DRAFT);
        expect(readSetupDraft()).toEqual(DRAFT);
    });

    it("is empty until something is written, and again once cleared", () => {
        expect(readSetupDraft()).toBeNull();
        writeSetupDraft(DRAFT);
        clearSetupDraft();
        expect(readSetupDraft()).toBeNull();
    });

    it("drops a draft that no longer fits instead of half-applying it", () => {
        for (const broken of [
            "not json at all",
            JSON.stringify({ ...DRAFT, strategy: "some-strategy-that-was-renamed" }),
            JSON.stringify({ ...DRAFT, step: 7 }),
            JSON.stringify({ ...DRAFT, zones: "all of them" }),
            JSON.stringify({ step: 1 })
        ]) {
            store.set(storedKey(), broken);
            expect(readSetupDraft(), broken).toBeNull();
        }
    });

    it("never carries the DuckDNS token, however it got in there", () => {
        expect(Object.keys(setupDraftSchema.shape)).not.toContain("duckToken");
        store.set(storedKey(), JSON.stringify({ ...DRAFT, duckToken: "a-secret-token" }));
        expect(JSON.stringify(readSetupDraft())).not.toContain("a-secret-token");
    });

    it("keeps working when the browser refuses to store anything", () => {
        stubStorage(true);
        expect(() => writeSetupDraft(DRAFT)).not.toThrow();
        expect(() => clearSetupDraft()).not.toThrow();
        expect(readSetupDraft()).toBeNull();
    });
});

/**
 * A setup state carrying the four things the resume rules read. The rest of the shape
 * is the server's to define and would only be a copy to maintain here.
 */
function setupState(saved: {
    environment?: ServerEnvironment;
    baseDomain?: string;
    zones?: SetupDraft["zones"];
    duckSub?: string;
    mode?: string;
    strategy?: SetupDraft["strategy"];
}): DomainSetupState {
    return {
        environment: { environment: saved.environment ?? "home-nat", detected: "home-nat", confirmed: true },
        network: { mode: saved.mode ?? "auto" },
        zones: { baseDomain: saved.baseDomain ?? "", zones: saved.zones ?? [] },
        domains: { duckdnsSubdomain: saved.duckSub ?? "" },
        strategy: saved.strategy ?? null,
        cloudflareConnected: false,
        records: []
    } as unknown as DomainSetupState;
}

describe("what the setup opens on", () => {
    it("shows the domain that is configured, not the strategy it would recommend", () => {
        const state = setupState({ baseDomain: "plr.example.com", zones: [{ label: "", scope: "deploy", primary: true }] });
        expect(configuredStrategy(state)).toBe("own-domain");
        expect(savedAnswers(state).baseDomain).toBe("plr.example.com");
    });

    it("tells a DuckDNS layout apart from a domain of the operator's own", () => {
        expect(configuredStrategy(setupState({ baseDomain: "mypolaris.duckdns.org" }))).toBe("duckdns");
    });

    it("reads a tunnel from the exposure mode, which is all a tunnel leaves behind", () => {
        expect(configuredStrategy(setupState({ mode: "tunnel" }))).toBe("cloudflare-tunnel");
    });

    it("gives back the strategy that was chosen, not the one its traces suggest", () => {
        // Both tunnels store the same mode and no domain, and a free subdomain stores
        // what an unconfigured box already holds - so only the saved answer tells them
        // apart, and it stands even where the inference would have answered too.
        expect(configuredStrategy(setupState({ mode: "tunnel", strategy: "quick-tunnel" }))).toBe("quick-tunnel");
        expect(configuredStrategy(setupState({ strategy: "free-subdomain", environment: "vps" }))).toBe(
            "free-subdomain"
        );
        expect(
            configuredStrategy(setupState({ baseDomain: "example.com", strategy: "cloudflare-tunnel" }))
        ).toBe("cloudflare-tunnel");
    });

    it("falls back to the recommendation only when nothing is configured at all", () => {
        const state = setupState({ environment: "vps" });
        expect(configuredStrategy(state)).toBeNull();
        expect(savedAnswers(state).strategy).toBe("own-domain");
    });
});

describe("whether a draft is worth keeping", () => {
    const state = setupState({
        baseDomain: "plr.example.com",
        zones: [{ label: "plr", scope: "polaris", primary: true }]
    });

    it("keeps nothing while the answers only repeat what is already saved", () => {
        expect(isUntouched(savedAnswers(state), state)).toBe(true);
    });

    it("keeps the answers the moment one of them differs", () => {
        const saved = savedAnswers(state);
        for (const changed of [
            { ...saved, baseDomain: "other.example.com" },
            { ...saved, environment: "vps" as ServerEnvironment },
            { ...saved, duckSub: "mypolaris" },
            { ...saved, strategy: "duckdns" as const },
            { ...saved, zones: [...saved.zones, { label: "apps", scope: "deploy" as const, primary: true }] },
            { ...saved, zones: [{ label: "plr", scope: "deploy" as const, primary: true }] }
        ]) {
            expect(isUntouched(changed, state), JSON.stringify(changed)).toBe(false);
        }
    });

    it("does not count the dashboard choice, which the server never keeps as an answer", () => {
        // It is carried out and cleared, so it always reads back as its default:
        // comparing it would call a saved setup unsaved for good.
        expect(isUntouched({ ...savedAnswers(state), useForDashboard: false }, state)).toBe(true);
    });
});
