import { describe, expect, it } from "vitest";
import { answerInstall, type InstallCallDeps } from "@/main/plugins/install-call";

function deps(overrides: Partial<InstallCallDeps> = {}): InstallCallDeps & { logged: string[]; after: string[][]; } {
    const logged: string[] = [];
    const after: string[][] = [];
    return {
        allowed: true,
        install: async () => ({ ok: true, started: true }),
        installedWith: async (_id, requires) => {
            after.push([...requires]);
        },
        log: (text) => logged.push(text),
        afterInstallLimitMs: 30,
        ...overrides,
        logged,
        after
    };
}

describe("the page's Install / Update call", () => {
    it("answers refused for a page that is not Polaris, or a malformed call", async () => {
        expect(await answerInstall(deps({ allowed: false }), "fixture-mixer", ["usb"], [])).toEqual({ ok: false, reason: "refused" });
        expect(await answerInstall(deps(), "Not An Id", ["usb"], [])).toEqual({ ok: false, reason: "refused" });
        expect(await answerInstall(deps(), "fixture-mixer", ["root"], [])).toEqual({ ok: false, reason: "refused" });
        expect(await answerInstall(deps(), "fixture-mixer", ["usb"], ["bad key"])).toEqual({ ok: false, reason: "refused" });
    });

    it("answers what the install answered, and keeps the consent after one that went in", async () => {
        const ok = deps();
        expect(await answerInstall(ok, "fixture-mixer", ["usb"], ["driver"])).toEqual({ ok: true, started: true });
        expect(ok.after).toEqual([["driver"]]);
        // A dashboard older than requirements sends none.
        const old = deps();
        expect(await answerInstall(old, "fixture-mixer", ["usb"], undefined)).toEqual({ ok: true, started: true });
        expect(old.after).toEqual([[]]);
        const failed = deps({ install: async () => ({ ok: false, reason: "timeout" }) });
        expect(await answerInstall(failed, "fixture-mixer", ["usb"], [])).toEqual({ ok: false, reason: "timeout" });
        expect(failed.after).toEqual([]);
    });

    it("answers a failure when the install throws, instead of leaving the page without an answer", async () => {
        const thrown = deps({ install: () => Promise.reject(new Error("socket closed")) });
        expect(await answerInstall(thrown, "fixture-mixer", ["usb"], [])).toEqual({ ok: false, reason: "failed" });
        expect(thrown.logged[0]).toMatch(/socket closed/);
    });

    it("still answers done when what runs after the install fails or hangs", async () => {
        const broken = deps({ installedWith: () => Promise.reject(new Error("disk full")) });
        expect(await answerInstall(broken, "fixture-mixer", ["usb"], ["driver"])).toEqual({ ok: true, started: true });
        expect(broken.logged[0]).toMatch(/disk full/);
        const hung = deps({ installedWith: () => new Promise(() => undefined) });
        expect(await answerInstall(hung, "fixture-mixer", ["usb"], ["driver"])).toEqual({ ok: true, started: true });
        expect(hung.logged[0]).toMatch(/still running/);
    });
});
