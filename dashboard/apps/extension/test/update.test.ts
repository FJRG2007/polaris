import { describe, expect, it } from "vitest";
import english from "../src/messages/en-US.json";
import spanish from "../src/messages/es-ES.json";
import {
    alarmNeedsCreating,
    AUTO_GRACE_MS,
    badgeFor,
    behindSince,
    checkDue,
    downloadUrl,
    effectiveKind,
    extensionsPage,
    packageBrowser,
    shouldAnnounce,
    UPDATE_CHECK_EVERY_MINUTES,
    UPDATE_MIN_GAP_MS,
    compareVersions,
    COUNT_COLOR,
    installKind,
    isNewer,
    managedByDesktop,
    noticeFor,
    publishedVersion,
    UPDATE_COLOR,
    upToDate,
    updatedByBrowser,
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

    it("counts a copy another program added from the store as the store's", () => {
        // The desktop app adds it through the browser's external-extension entry,
        // which the browser reports as `sideload` and updates from the store.
        const store = "https://clients2.google.com/service/update2/crx";
        expect(installKind("sideload", false, false, store)).toBe("store");
        expect(installKind("admin", false, false, store)).toBe("store");
        expect(updatedByBrowser("sideload", store)).toBe(true);
        expect(updatedByBrowser("normal")).toBe(true);
    });

    it("never counts an unpacked copy or a missing or odd address as updated by the browser", () => {
        expect(updatedByBrowser("development", "https://clients2.google.com/service/update2/crx")).toBe(false);
        expect(updatedByBrowser("sideload", null)).toBe(false);
        expect(updatedByBrowser("sideload", "")).toBe(false);
        expect(updatedByBrowser("sideload", "not an address")).toBe(false);
        expect(updatedByBrowser("sideload", "file:///tmp/update.xml")).toBe(false);
        expect(installKind("development", true, false, "https://clients2.google.com/service/update2/crx")).toBe("auto");
    });

    it("carries the update address into the notice", () => {
        const answer = { version: "9.0.0", url: "https://example.com/release" };
        expect(noticeFor(answer, "1.0.0", "sideload", false, false, "https://edge.microsoft.com/extensionwebstorebase/v1/crx")?.kind).toBe("store");
        expect(noticeFor(answer, "1.0.0", "sideload")?.kind).toBe("manual");
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

    it("marks every install's update until its notice is dismissed", () => {
        for (const kind of ["store", "auto"] as const) {
            expect(badgeFor("", notice(kind))).toEqual({
                text: "!",
                color: UPDATE_COLOR,
                announce: "0.2.0"
            });
            expect(badgeFor("", notice(kind), "0.2.0").text).toBe("");
            // A dismissal of an older version is not one of this one.
            expect(badgeFor("", notice(kind), "0.1.9").text).toBe("!");
        }
        // By hand there is still something to do after the notice is closed.
        expect(badgeFor("", notice("manual"), "0.2.0").text).toBe("!");
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
            for (const key of [
                "store",
                "auto",
                "manual",
                "download",
                "stepsChromium",
                "stepsFirefox",
                "openExtensions",
                "changes",
                "dismiss",
                "ready",
                "startNow",
                "startNowHint",
                "title"
            ] as const)
                expect(catalog.popup.update[key]).toBeTruthy();
            for (const key of [
                "running",
                "current",
                "available",
                "store",
                "auto",
                "manual",
                "updateNow"
            ] as const)
                expect(catalog.popup.version[key]).toBeTruthy();
        }
    });

    it("promises an update by itself only where something delivers one", () => {
        // The store and the updater install it; a folder loaded by hand is
        // never updated by the browser, and is told so.
        expect(english.popup.version.store).toBe("Installs itself within hours");
        expect(english.popup.update.store).toMatch(/browser installs it within hours/);
        expect(english.popup.update.auto).toMatch(/updater/);
        expect(english.popup.version.manual).toBe("Update it by hand");
        expect(english.popup.update.manual).toMatch(/by hand/);
        expect(english.popup.update.manual).not.toMatch(/within hours|itself/);
        expect(spanish.popup.update.manual).toMatch(/a mano/);
        expect(spanish.popup.update.manual).not.toMatch(/en horas|sola/);
        for (const catalog of all)
            for (const key of ["store", "auto", "manual"] as const)
                expect(catalog.popup.update[key]).toContain("{version}");
    });

    it("keeps the Spanish near the English length", () => {
        for (const section of ["update", "version"] as const) {
            const en = english.popup[section] as Record<string, string>;
            const es = spanish.popup[section] as Record<string, string>;
            for (const key of Object.keys(en)) {
                expect(es[key], key).toBeTruthy();
                expect(es[key]!.length, key).toBeLessThanOrEqual(Math.ceil(en[key]!.length * 1.3) + 4);
            }
        }
    });

    it("never asks anybody to run a command", () => {
        // Polaris is used without a terminal. A shell, a line to paste or a
        // script to run is a dead end on the screen that says it.
        const text = JSON.stringify(all.map((catalog) => catalog.popup));
        expect(text).not.toMatch(/PowerShell|Terminal|\brun this\b|ejecuta|\bcommand\b|comando/i);
    });
});

describe("the version line's Up to date", () => {
    it("is said once Polaris named a version that is not ahead, and only then", () => {
        expect(upToDate("0.1.115", "0.1.115", null)).toBe(true);
        expect(upToDate(null, "0.1.115", null)).toBe(false);
        expect(upToDate("0.1.116", "0.1.115", null)).toBe(false);
        expect(upToDate("0.1.115", "0.1.115", "0.1.116")).toBe(false);
    });
});
describe("how this build got here, for the advice", () => {
    it("reads an unpacked or temporary load as by hand, without the updater", () => {
        // Chromium's Load unpacked and Firefox's temporary add-on both report
        // `development`.
        expect(installKind("development")).toBe("manual");
        expect(installKind("development", true)).toBe("auto");
    });

    it("reads a copy put there by policy or other software, with no update address, as by hand", () => {
        expect(installKind("admin")).toBe("manual");
        expect(installKind("sideload")).toBe("manual");
        expect(installKind("other")).toBe("manual");
        expect(installKind(null)).toBe("manual");
    });

    it("reads a store install as the browser's", () => {
        expect(installKind("normal")).toBe("store");
        expect(installKind("admin", false, false, "https://clients2.google.com/service/update2/crx")).toBe(
            "store"
        );
    });
});

describe("the updater's promise", () => {
    const start = 1_000_000;

    it("starts counting when this version first hears of a newer one, and keeps that time", () => {
        const first = behindSince(null, "0.1.275", true, start);
        expect(first).toEqual({ running: "0.1.275", at: start });
        expect(behindSince(first, "0.1.275", true, start + 5000)).toBe(first);
    });

    it("starts again on another running version, and clears when nothing is newer", () => {
        const first = behindSince(null, "0.1.275", true, start);
        expect(behindSince(first, "0.1.276", true, start + 10)).toEqual({
            running: "0.1.276",
            at: start + 10
        });
        expect(behindSince(first, "0.1.275", false, start + 10)).toBeNull();
    });

    it("stops promising after the grace, and tells it to update by hand", () => {
        const since = { running: "0.1.275", at: start };
        expect(effectiveKind("auto", since, start + AUTO_GRACE_MS)).toBe("auto");
        expect(effectiveKind("auto", since, start + AUTO_GRACE_MS + 1)).toBe("manual");
        expect(effectiveKind("auto", null, start + AUTO_GRACE_MS * 10)).toBe("auto");
    });

    it("leaves every other kind as it is", () => {
        const since = { running: "0.1.275", at: start };
        for (const kind of ["store", "manual", "desktop"] as const)
            expect(effectiveKind(kind, since, start + AUTO_GRACE_MS * 10)).toBe(kind);
    });

    it("tells it to update by hand at once when the updater says it is not working", () => {
        expect(effectiveKind("auto", null, start, true)).toBe("manual");
        expect(effectiveKind("auto", { running: "0.1.275", at: start }, start, true)).toBe("manual");
        expect(effectiveKind("store", null, start, true)).toBe("store");
    });
});

describe("checking in the background", () => {
    const now = 50 * UPDATE_MIN_GAP_MS;

    it("checks every few hours", () => {
        expect(UPDATE_CHECK_EVERY_MINUTES).toBeGreaterThanOrEqual(60);
        expect(UPDATE_CHECK_EVERY_MINUTES).toBeLessThanOrEqual(12 * 60);
    });

    it("creates the alarm only when it is missing or on another period", () => {
        expect(alarmNeedsCreating(undefined)).toBe(true);
        expect(alarmNeedsCreating(null)).toBe(true);
        expect(alarmNeedsCreating({ periodInMinutes: 12 * 60 })).toBe(true);
        // Recreating a held alarm restarts its period: never done.
        expect(alarmNeedsCreating({ periodInMinutes: UPDATE_CHECK_EVERY_MINUTES })).toBe(false);
    });

    it("holds a worker's own starts to one check an hour", () => {
        expect(checkDue(null, now)).toBe(true);
        expect(checkDue(now - 60_000, now)).toBe(false);
        expect(checkDue(now - UPDATE_MIN_GAP_MS, now)).toBe(true);
        // A clock set back is not a reason to go quiet.
        expect(checkDue(now + 60_000, now)).toBe(true);
        expect(checkDue(Number.NaN, now)).toBe(true);
    });
});

describe("the one-time notice", () => {
    const notice = (kind: UpdateNotice["kind"], version = "0.1.279"): UpdateNotice => ({
        version,
        url: "https://github.com/example/polaris/releases/tag/extension-v0.1.279",
        kind
    });

    it("is shown for a version until it is dismissed, and again for the next", () => {
        expect(shouldAnnounce(notice("manual"), null)).toBe(true);
        expect(shouldAnnounce(notice("manual"), "0.1.279")).toBe(false);
        expect(shouldAnnounce(notice("store", "0.1.280"), "0.1.279")).toBe(true);
    });

    it("says nothing with no update, or for the desktop app", () => {
        expect(shouldAnnounce(null, null)).toBe(false);
        expect(shouldAnnounce(notice("desktop"), null)).toBe(false);
    });
});

describe("updating by hand", () => {
    const release = "https://github.com/example/polaris/releases/tag/extension-v0.1.279";

    it("downloads the release's package for this browser", () => {
        expect(downloadUrl(release, "chrome")).toBe(
            "https://github.com/example/polaris/releases/download/extension-v0.1.279/polaris-extension-chrome.zip"
        );
        expect(downloadUrl(release, "firefox")).toBe(
            "https://github.com/example/polaris/releases/download/extension-v0.1.279/polaris-extension-firefox.zip"
        );
        expect(packageBrowser("edge")).toBe("chrome");
        expect(packageBrowser("firefox")).toBe("firefox");
    });

    it("falls back to the page it was given for anything else", () => {
        for (const other of [
            "https://example.test/releases/tag/x",
            "http://github.com/a/b/releases/tag/x",
            "https://github.com/a/b/releases",
            "not a url"
        ])
            expect(downloadUrl(other, "chrome")).toBe(other);
    });

    it("opens the extensions page on Chromium only", () => {
        expect(extensionsPage("chrome", "abc")).toBe("chrome://extensions/?id=abc");
        expect(extensionsPage("edge", "abc")).toBe("chrome://extensions/?id=abc");
        expect(extensionsPage("firefox", "abc")).toBeNull();
    });
});
