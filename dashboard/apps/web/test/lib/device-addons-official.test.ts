import { describe, expect, it, vi } from "vitest";
import { controlsByPage } from "@/app/(app)/account/addons/official-choice-dialog";
import { lookOfficial, readOfficialChoice, readOfficialRestore, statusSentence, type AddonsBridge, type OfficialControl } from "@/lib/device-addons-client";

const LOOK = {
    found: { app: { displayName: "Hercules Stream Control", version: "1.2" }, drivers: null, autostart: [{}], running: true },
    imported: { pages: 1, controls: [{ page: 1, slot: 1, control: "knob", official: "Apps > Multi-app volume", name: "Music", mapped: { key: "knob1", value: "music" }, kept: true }] },
    backup: null
};

function bridgeAnswering(answer: unknown): AddonsBridge {
    return { official: vi.fn(async () => answer) } as unknown as AddonsBridge;
}

describe("the official software, as the page reads the app's answers", () => {
    it("reads a look, and none from an older app or a malformed answer", async () => {
        expect((await lookOfficial(bridgeAnswering(LOOK), "hercules-stream100"))?.found?.app?.displayName).toBe("Hercules Stream Control");
        expect(await lookOfficial({} as AddonsBridge, "hercules-stream100")).toBeNull();
        expect(await lookOfficial(null, "hercules-stream100")).toBeNull();
        expect(await lookOfficial(bridgeAnswering({ found: "yes" }), "hercules-stream100")).toBeNull();
        expect(await lookOfficial({ official: () => Promise.reject(new Error("gone")) } as unknown as AddonsBridge, "x")).toBeNull();
    });

    it("words every reason a choice was not carried out, and an unknown one as a failure", () => {
        expect(readOfficialChoice({ ok: true })).toEqual({ ok: true });
        expect(readOfficialChoice({ ok: false, reason: "declined" })).toEqual({ ok: false, reason: "declined", install: null });
        expect(readOfficialChoice({ ok: false, reason: "install", install: "hash" })).toEqual({ ok: false, reason: "install", install: "integrity" });
        expect(readOfficialChoice({ ok: false, reason: "somethingNew" })).toEqual({ ok: false, reason: "failed", install: null });
        expect(readOfficialChoice(null)).toEqual({ ok: false, reason: "failed", install: null });
    });

    it("says when only the settings went back", () => {
        const base = { ok: true, autostart: 1, settings: true, started: true, missing: false, declined: false };
        expect(readOfficialRestore(base)).toBe("done");
        expect(readOfficialRestore({ ...base, missing: true, started: false })).toBe("settingsOnly");
        expect(readOfficialRestore({ ...base, ok: false, declined: true })).toBe("declined");
        expect(readOfficialRestore({ ...base, ok: false })).toBe("failed");
        expect(readOfficialRestore("nope")).toBe("failed");
    });

    it("translates only the status sentences it knows", () => {
        expect(statusSentence("herculesDriver")).toBe("statusDetail.herculesDriver");
        expect(statusSentence("fromTheFuture")).toBeNull();
        expect(statusSentence(undefined)).toBeNull();
    });

    it("groups the imported controls by page, knobs before buttons", () => {
        const control = (page: number, kind: "knob" | "button", slot: number): OfficialControl => ({ page, slot, control: kind, official: "", name: "", mapped: null, kept: false });
        const grouped = controlsByPage([control(2, "knob", 1), control(1, "button", 1), control(1, "knob", 2), control(1, "knob", 1)]);
        expect(grouped.map(([page, list]) => [page, list.map((item) => `${item.control}${item.slot}`)])).toEqual([
            [1, ["knob1", "knob2", "button1"]],
            [2, ["knob1"]]
        ]);
    });
});
