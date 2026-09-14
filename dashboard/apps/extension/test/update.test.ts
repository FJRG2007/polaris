import { describe, expect, it } from "vitest";
import { compareVersions, installKind, isNewer, noticeFor } from "../src/lib/update";

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
});
