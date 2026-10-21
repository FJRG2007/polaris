import { describe, expect, it } from "vitest";
import english from "../src/messages/en-US.json";
import spanish from "../src/messages/es-ES.json";
import {
    badgeFor,
    compareVersions,
    COUNT_COLOR,
    installKind,
    isNewer,
    managedByDesktop,
    noticeFor,
    publishedVersion,
    UPDATE_COLOR,
    type UpdateNotice
} from "../src/lib/update";

/**
 * Knowing a newer extension exists, and what to tell whoever is running the old
 * one.
 *
 * Two ways of getting this wrong, and both are silent.
 *
 * Comparing versions as text. `"0.10.0" < "0.2.0"` is true of strings and false
 * of versions, so a string compare reports "up to date" for every release after
 * the ninth - the failure arrives months later and looks like nothing at all.
 *
 * And telling the wrong person to do the wrong thing. Somebody who installed from
 * a store must not be sent to re-load a folder by hand, and somebody who loaded it
 * by hand must not be told to sit and wait for an update that will never come.
 */

describe("comparing two versions", () => {
    it("orders by number, not by text", () => {
        // The one that a string comparison gets backwards.
        expect(isNewer("0.10.0", "0.2.0")).toBe(true);
        expect(isNewer("0.2.0", "0.10.0")).toBe(false);
        expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
    });

    it("treats a missing segment as zero", () => {
        expect(compareVersions("0.2", "0.2.0")).toBe(0);
        expect(compareVersions("1", "1.0.0")).toBe(0);
        expect(isNewer("0.2.1", "0.2")).toBe(true);
    });

    it("ignores a leading v, which is how the tag spells it", () => {
        expect(compareVersions("v0.1.1", "0.1.1")).toBe(0);
        expect(isNewer("v0.1.2", "0.1.1")).toBe(true);
    });

    it("is not newer when it is the same version", () => {
        expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    });

    it("does not throw on something that is not a version", () => {
        // It arrives from the network, so the answer has to be an ordering rather
        // than an exception thrown inside a background worker.
        expect(() => compareVersions("", "0.1.0")).not.toThrow();
        expect(isNewer("", "0.1.0")).toBe(false);
        expect(isNewer("banana", "0.1.0")).toBe(false);
    });
});

describe("how this build got here", () => {
    it("counts only a package install as something that updates itself", () => {
        expect(installKind("normal")).toBe("store");
    });

    it("treats everything else as loaded by hand", () => {
        // `development` is the unpacked load this warning exists for. The other
        // three are installs Polaris cannot promise anything about, so they are
        // told how to do it themselves rather than left waiting.
        expect(installKind("development")).toBe("manual");
        expect(installKind("sideload")).toBe("manual");
        expect(installKind("admin")).toBe("manual");
        expect(installKind("other")).toBe("manual");
        expect(installKind(undefined)).toBe("manual");
        expect(installKind(null)).toBe("manual");
    });

    it("counts an unpacked copy as kept current only when the updater marked its folder", () => {
        expect(installKind("development", true)).toBe("auto");
        expect(installKind("development", false)).toBe("manual");
        // The marker means nothing on a copy no updater can write to, and a
        // store install stays the store's whatever a folder says.
        expect(installKind("sideload", true)).toBe("manual");
        expect(installKind("normal", true)).toBe("store");
    });

    it("leaves the desktop app a kind of its own, which nothing produces yet", () => {
        expect(installKind("development", true, true)).toBe("desktop");
        expect(installKind("normal", false, true)).toBe("store");
        // There is no desktop app: until there is, nothing may claim it.
        expect(managedByDesktop()).toBe(false);
    });
});

describe("what to show", () => {
    const RELEASE = { version: "0.2.0", url: "https://example.test/releases/extension-v0.2.0" };

    it("says nothing when the running build is the published one", () => {
        expect(noticeFor(RELEASE, "0.2.0", "development")).toBeNull();
    });

    it("says nothing when the running build is newer than the release", () => {
        // A build loaded from a checkout ahead of the last tag, which is the
        // ordinary state of whoever is working on it.
        expect(noticeFor(RELEASE, "0.3.0", "development")).toBeNull();
    });

    it("says nothing when nothing is published, or nobody answered", () => {
        expect(noticeFor(null, "0.1.0", "development")).toBeNull();
        expect(noticeFor({ version: null, url: null }, "0.1.0", "development")).toBeNull();
    });

    it("refuses an answer that is not the shape it should be", () => {
        // The server is one the reader named, so what it says is checked here.
        expect(noticeFor({ version: "0.2.0" }, "0.1.0", "development")).toBeNull();
        expect(noticeFor({ version: 2, url: "https://example.test/r" }, "0.1.0", null)).toBeNull();
    });

    it("carries how to update it, not only that there is an update", () => {
        const manual = noticeFor(RELEASE, "0.1.0", "development");
        expect(manual).toEqual({ version: "0.2.0", url: RELEASE.url, kind: "manual" });

        const store = noticeFor(RELEASE, "0.1.0", "normal");
        expect(store?.kind).toBe("store");
    });

    it("tells a copy the updater keeps current that there is nothing to do", () => {
        expect(noticeFor(RELEASE, "0.1.0", "development", true)?.kind).toBe("auto");
    });
});

describe("the newest version out", () => {
    it("is read only from an answer that names one", () => {
        expect(publishedVersion({ version: "0.2.0", url: null })).toBe("0.2.0");
        expect(publishedVersion({ version: null })).toBeNull();
        expect(publishedVersion({ version: 2 })).toBeNull();
        expect(publishedVersion(null)).toBeNull();
    });
});

describe("the toolbar badge", () => {
    const notice = (kind: UpdateNotice["kind"]): UpdateNotice => ({
        version: "0.2.0",
        url: "https://example.test/r",
        kind
    });

    it("shows the login count, and nothing else, with no update", () => {
        expect(badgeFor("3", null)).toEqual({ text: "3", color: COUNT_COLOR, announce: null });
        expect(badgeFor("", null)).toEqual({ text: "", color: COUNT_COLOR, announce: null });
    });

    it("marks a hand-loaded copy's update where there is no count to show", () => {
        expect(badgeFor("", notice("manual"))).toEqual({
            text: "!",
            color: UPDATE_COLOR,
            announce: "0.2.0"
        });
    });

    it("lets the count win, and still names the update in the tooltip", () => {
        expect(badgeFor("2", notice("manual"))).toEqual({
            text: "2",
            color: COUNT_COLOR,
            announce: "0.2.0"
        });
    });

    it("asks nothing of an install that updates without anybody", () => {
        expect(badgeFor("", notice("store")).text).toBe("");
        expect(badgeFor("", notice("auto")).text).toBe("");
        expect(badgeFor("", notice("store")).announce).toBe("0.2.0");
        // The desktop app says it itself.
        expect(badgeFor("", notice("desktop"))).toEqual({
            text: "",
            color: COUNT_COLOR,
            announce: null
        });
    });
});

describe("what the popup says about it", () => {
    const all = [english, spanish];

    it("has every line in both languages", () => {
        for (const catalog of all) {
            for (const key of ["byHand", "ready", "startNow", "startNowHint", "title"] as const)
                expect(catalog.popup.update[key]).toBeTruthy();
            for (const key of [
                "running",
                "current",
                "available",
                "store",
                "auto",
                "manual"
            ] as const)
                expect(catalog.popup.version[key]).toBeTruthy();
        }
    });

    it("never asks anybody to run a command", () => {
        // Polaris is used without a terminal. A shell, a line to paste or a
        // script to run is a dead end on the screen that says it.
        const text = JSON.stringify(all.map((catalog) => catalog.popup));
        expect(text).not.toMatch(/PowerShell|Terminal|run this|ejecuta|command|comando/i);
    });
});
