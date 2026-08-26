// @vitest-environment jsdom

/**
 * A kept reading belongs to the build that wrote it.
 *
 * sessionStorage survives the reload that takes a tab onto a new build, so
 * without this the first paint after an update draws yesterday's payload into
 * today's component - and a field the new one reads is not there. That is not a
 * failed request anybody can retry: it is a crash before anything was asked for,
 * and it reads as the screen itself being broken. It happened to the Polaris
 * footprint card, whose payload grew a `rest` object the kept one did not have.
 */

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

async function store() {
    // Fresh module per test: the build is remembered once per document, which is
    // the behaviour being exercised.
    vi.resetModules();
    return import("@/lib/snapshot-cache");
}

beforeEach(() => {
    sessionStorage.clear();
});

describe("a snapshot from another build", () => {
    it("is refused, rather than painted into the component that replaced it", async () => {
        const first = await store();
        first.rememberSnapshotBuild("build-one");
        first.writeSnapshot("polaris.footprint", { parts: [], rest: { containers: 2 } });

        const next = await store();
        next.rememberSnapshotBuild("build-two");
        expect(next.readSnapshot("polaris.footprint", 60_000)).toBeNull();
    });

    it("is refused when it predates snapshots carrying a build at all", async () => {
        sessionStorage.setItem(
            "polaris.live.polaris.footprint",
            JSON.stringify({ at: Date.now(), value: { parts: [] } })
        );
        const now = await store();
        now.rememberSnapshotBuild("build-two");
        expect(now.readSnapshot("polaris.footprint", 60_000)).toBeNull();
    });
});

describe("a snapshot from this build", () => {
    it("is painted, which is the whole point of keeping it", async () => {
        const now = await store();
        now.rememberSnapshotBuild("build-one");
        now.writeSnapshot("drive.listing", { files: 3 });
        expect(now.readSnapshot<{ files: number }>("drive.listing", 60_000)?.value).toEqual({ files: 3 });
    });

    it("is still refused once it is older than the caller allows", async () => {
        const now = await store();
        now.rememberSnapshotBuild("build-one");
        now.writeSnapshot("drive.listing", { files: 3 });
        expect(now.readSnapshot("drive.listing", -1)).toBeNull();
    });
});

describe("a deployment with no build stamp", () => {
    it("keeps its cache: there is nothing to compare, and the shape is whatever was just built", async () => {
        const now = await store();
        now.rememberSnapshotBuild(null);
        now.writeSnapshot("drive.listing", { files: 3 });
        expect(now.readSnapshot("drive.listing", 60_000)).not.toBeNull();
    });

    it("keeps it for a surface the shell never told, rather than losing it to an unanswered question", async () => {
        const first = await store();
        first.writeSnapshot("drive.listing", { files: 3 });
        expect(first.readSnapshot("drive.listing", 60_000)).not.toBeNull();
    });
});

describe("where the shell tells the store", () => {
    it("is settled before the screen below it asks", async () => {
        // The guarantee the placement rests on: React renders a parent's children
        // in order, so a component above the page has already run by the time the
        // page's render reads its kept snapshot. An effect would be too late - the
        // poisoned paint is the first one.
        sessionStorage.setItem(
            "polaris.live.polaris.footprint",
            JSON.stringify({ at: Date.now(), build: "build-one", value: { parts: [] } })
        );
        const cache = await store();
        const { SnapshotBuild } = await import("@/components/snapshot-build");

        let seen: unknown = "not read";
        function Screen() {
            seen = cache.readSnapshot("polaris.footprint", 60_000);
            return null;
        }

        render(
            <>
                <SnapshotBuild build="build-two" />
                <Screen />
            </>
        );
        expect(seen).toBeNull();
    });
});
