/**
 * What the update card is told.
 *
 * The rule under test is that an update means a published image, not a commit: CI
 * needs minutes to build one, and offering an update in that window produced a
 * pull that changed nothing and a card that kept offering it. So a branch that has
 * moved ahead of the registry is "building", not "available", and only an image
 * whose commit differs from the running one is an update.
 *
 * The second rule is that a commit which failed its checks is not an update. The
 * image behind the tag can only come from a passing commit while publishing is
 * gated on CI, but a manual run or an older image can still leave a red build
 * there, and offering it is how a broken build reaches a box that pressed Update.
 *
 * The other half is that GitHub is optional. It supplies the commit count, the
 * building hint and the CI verdict; when it is rate-limited or unreachable the
 * registry alone still has to produce a correct answer.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublishedImage } from "../../src/lib/registry";
import type { UpdateStatus } from "../../src/lib/update-service";

const RUNNING = "1111111111111111111111111111111111111111";
const NEWER = "2222222222222222222222222222222222222222";

/** A GitHub compare response, or an outage when `null`. */
interface Compare {
    readonly status: string;
    readonly ahead_by: number;
    readonly files?: { filename: string; }[];
}

/** One entry of a check-runs response. */
interface CheckRun {
    /** The job name, which is what says which image the run gates. */
    readonly name?: string;
    readonly status: string;
    readonly conclusion: string | null;
    readonly html_url?: string;
}

async function check(options: {
    running?: string;
    published: PublishedImage;
    compare?: Compare | null;
    /** What CI says about the newest commit; `null` is an outage. */
    checks?: CheckRun[] | null;
    /** Where this deployment takes its updates from. Defaults to the image. */
    source?: "image" | "build";
    /** The commit the branch points at, for a deployment that builds its own. */
    head?: string | null;
}): Promise<UpdateStatus> {
    vi.resetModules();
    vi.doMock("../../src/lib/update-source", () => ({
        getUpdateSource: async () => options.source ?? "image"
    }));
    vi.doMock("@polaris/config", () => ({
        loadEnv: () => ({
            POLARIS_REPO: "o/p",
            POLARIS_UPDATE_BRANCH: "main",
            POLARIS_BUILD_SHA: options.running ?? RUNNING,
            POLARIS_WEB_IMAGE: "ghcr.io/o/p",
            POLARIS_IMAGE_TAG: "latest"
        })
    }));
    vi.doMock("../../src/lib/registry", () => ({
        readPublishedImage: async (): Promise<PublishedImage> => options.published
    }));
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            const path = String(url);
            let answer: unknown;
            if (path.includes("/check-runs")) answer = options.checks && { check_runs: options.checks };
            else if (path.includes("/compare/")) answer = options.compare;
            // A deployment that builds its own image asks what the branch points at.
            else answer = options.head === undefined ? null : options.head && { sha: options.head };
            return answer
                ? new Response(JSON.stringify(answer), { status: 200 })
                : new Response("rate limited", { status: 403 });
        })
    );
    const { getUpdateStatus } = await import("../../src/lib/update-service");
    return getUpdateStatus(true);
}

const IMAGE = (buildSha: string | null): PublishedImage => ({
    digest: "sha256:d",
    buildSha,
    createdAt: "2026-07-30T13:35:18Z"
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("@polaris/config");
    vi.doUnmock("../../src/lib/registry");
    vi.doUnmock("../../src/lib/update-source");
});

describe("what counts as an update", () => {
    it("offers the update when the registry serves a newer image", async () => {
        const status = await check({
            published: IMAGE(NEWER),
            compare: { status: "ahead", ahead_by: 3 }
        });

        expect(status.phase).toBe("available");
        expect(status.behindBy).toBe(3);
        expect(status.latest).toBe("2222222");
        expect(status.upToDate).toBe(false);
    });

    it("says nothing is available while the commit is still being built", async () => {
        const status = await check({
            published: IMAGE(RUNNING),
            compare: { status: "ahead", ahead_by: 2, files: [{ filename: "dashboard/apps/web/src/page.tsx" }] }
        });

        expect(status.phase).toBe("building");
        expect(status.buildingCount).toBe(2);
        expect(status.upToDate).toBe(false);
        // Nothing to install: the image behind the tag is the one already running.
        expect(status.behindBy).toBe(0);
    });

    it("stays up to date when the new commits produce no dashboard image", async () => {
        const status = await check({
            published: IMAGE(RUNNING),
            compare: { status: "ahead", ahead_by: 4, files: [{ filename: "docs/readme.md" }] }
        });

        expect(status.phase).toBe("up-to-date");
        expect(status.upToDate).toBe(true);
    });

    it("is up to date when the running build is the published one", async () => {
        const status = await check({ published: IMAGE(RUNNING), compare: { status: "identical", ahead_by: 0 } });

        expect(status.phase).toBe("up-to-date");
        expect(status.upToDate).toBe(true);
    });

    it("does not call a locally-built newer deployment behind", async () => {
        const status = await check({
            running: NEWER,
            published: IMAGE(RUNNING),
            compare: { status: "behind", ahead_by: 0 }
        });

        expect(status.phase).toBe("up-to-date");
    });

    it("reports an unplaceable deployment as unknown rather than up to date", async () => {
        const status = await check({ running: "", published: IMAGE(NEWER), compare: null });

        expect(status.phase).toBe("unknown");
        expect(status.upToDate).toBe(false);
        expect(status.current).toBeNull();
    });
});

describe("a commit that failed its checks", () => {
    const PASSED: CheckRun[] = [
        { name: "changes", status: "completed", conclusion: "success" },
        { name: "dashboard-ci / build", status: "completed", conclusion: "success" },
        // A job the push did not need is not a job that failed.
        { name: "web", status: "completed", conclusion: "skipped" }
    ];
    const FAILED: CheckRun[] = [
        { name: "changes", status: "completed", conclusion: "success" },
        {
            name: "dashboard-ci / build",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/o/p/actions/runs/1/job/2"
        }
    ];

    it("is not offered, even with the image already published", async () => {
        const status = await check({
            published: IMAGE(NEWER),
            compare: { status: "ahead", ahead_by: 1 },
            checks: FAILED
        });

        expect(status.phase).toBe("blocked");
        expect(status.checks).toBe("failed");
        expect(status.checksUrl).toBe("https://github.com/o/p/actions/runs/1/job/2");
    });

    it("is not called a build still on its way", async () => {
        const status = await check({
            published: IMAGE(RUNNING),
            compare: { status: "ahead", ahead_by: 1, files: [{ filename: "dashboard/apps/web/src/page.tsx" }] },
            checks: FAILED
        });

        expect(status.phase).toBe("blocked");
        expect(status.upToDate).toBe(false);
    });

    it("is offered once the checks pass", async () => {
        const status = await check({
            published: IMAGE(NEWER),
            compare: { status: "ahead", ahead_by: 1 },
            checks: PASSED
        });

        expect(status.phase).toBe("available");
        expect(status.checks).toBe("passed");
    });

    it("is still offered while a run is going - unfinished is not failed", async () => {
        const status = await check({
            published: IMAGE(NEWER),
            compare: { status: "ahead", ahead_by: 1 },
            checks: [{ name: "dashboard-ci / build", status: "in_progress", conclusion: null }]
        });

        expect(status.phase).toBe("available");
        expect(status.checks).toBe("running");
    });
});

/**
 * One commit builds several images. The dashboard is gated on its own suites, so
 * a host-daemon failure on the same commit must not hold it back - and holding it
 * back was permanent, because the commits that fix the daemon rebuild no dashboard
 * image, leaving the tag parked on the commit being held against it.
 */
describe("a failure that belongs to another image", () => {
    // The exact run names GitHub reported for the commit this was found on: the
    // dashboard image built and published, the host daemon failed its formatting
    // gate, and the card refused to offer the image because of it.
    it("does not block the dashboard image", async () => {
        const status = await check({
            published: IMAGE(NEWER),
            compare: { status: "ahead", ahead_by: 1 },
            checks: [
                { name: "bridge", status: "completed", conclusion: "skipped" },
                { name: "web", status: "completed", conclusion: "success" },
                { name: "hostd-manifest", status: "completed", conclusion: "skipped" },
                { name: "hostd", status: "completed", conclusion: "skipped" },
                { name: "updater", status: "completed", conclusion: "skipped" },
                { name: "mdns", status: "completed", conclusion: "skipped" },
                { name: "rust-ci / python", status: "completed", conclusion: "success" },
                { name: "rust-ci / rust", status: "completed", conclusion: "failure", html_url: "https://ci/rust" },
                { name: "dashboard-ci / build", status: "completed", conclusion: "success" },
                { name: "changes", status: "completed", conclusion: "success" },
                { name: "rust", status: "completed", conclusion: "failure", html_url: "https://ci/rust" },
                { name: "python", status: "completed", conclusion: "success" },
                { name: "build", status: "completed", conclusion: "success" }
            ]
        });

        expect(status.phase).toBe("available");
        expect(status.checks).toBe("passed");
        expect(status.checksUrl).toBeNull();
    });

    it("still blocks when the failure is the dashboard's own", async () => {
        const status = await check({
            published: IMAGE(NEWER),
            compare: { status: "ahead", ahead_by: 1 },
            checks: [
                { name: "rust", status: "completed", conclusion: "success" },
                { name: "web", status: "completed", conclusion: "failure", html_url: "https://ci/web" }
            ]
        });

        expect(status.phase).toBe("blocked");
        expect(status.checksUrl).toBe("https://ci/web");
    });

    it("judges a host build by every suite, since it builds the whole checkout", async () => {
        const status = await check({
            source: "build",
            published: IMAGE(RUNNING),
            head: NEWER,
            compare: { status: "ahead", ahead_by: 1 },
            checks: [
                { name: "web", status: "completed", conclusion: "success" },
                { name: "rust", status: "completed", conclusion: "failure", html_url: "https://ci/rust" }
            ]
        });

        expect(status.phase).toBe("blocked");
        expect(status.checksUrl).toBe("https://ci/rust");
    });

    it("treats a commit with no dashboard suite at all as unjudged, not failed", async () => {
        const status = await check({
            published: IMAGE(NEWER),
            compare: { status: "ahead", ahead_by: 1 },
            checks: [{ name: "rust", status: "completed", conclusion: "failure", html_url: "https://ci/rust" }]
        });

        expect(status.phase).toBe("available");
        expect(status.checks).toBeNull();
    });
});

describe("when GitHub cannot be reached", () => {
    it("still offers an update the registry can prove exists", async () => {
        const status = await check({ published: IMAGE(NEWER), compare: null });

        expect(status.phase).toBe("available");
        // The count is what is lost, not the answer.
        expect(status.behindBy).toBeNull();
        expect(status.error).toBeUndefined();
    });

    it("does not invent a pending build for a deployment that is current", async () => {
        const status = await check({ published: IMAGE(RUNNING), compare: null });

        expect(status.phase).toBe("up-to-date");
    });
});

/**
 * A deployment that builds its own image asks a different question: the branch is
 * the target, so a commit can be installed the moment it lands and there is never
 * anything "still building" to wait for. The registry has no say in it - what it
 * serves is precisely what this deployment has chosen not to run.
 */
describe("a deployment that builds on the host", () => {
    it("offers a commit as soon as it lands, whatever the registry serves", async () => {
        const status = await check({
            source: "build",
            published: IMAGE(RUNNING),
            head: NEWER,
            compare: { status: "ahead", ahead_by: 4 }
        });

        expect(status.source).toBe("build");
        expect(status.phase).toBe("available");
        expect(status.latest).toBe("2222222");
        expect(status.behindBy).toBe(4);
    });

    it("is up to date when the branch head is what it built", async () => {
        const status = await check({ source: "build", published: IMAGE(NEWER), head: RUNNING });

        expect(status.phase).toBe("up-to-date");
        expect(status.upToDate).toBe(true);
    });

    it("does not offer a commit that failed its checks", async () => {
        const status = await check({
            source: "build",
            published: IMAGE(RUNNING),
            head: NEWER,
            compare: { status: "ahead", ahead_by: 1 },
            checks: [{ status: "completed", conclusion: "failure", html_url: "https://ci/run/9" }]
        });

        expect(status.phase).toBe("blocked");
        expect(status.checksUrl).toBe("https://ci/run/9");
    });

    it("says it does not know when the branch cannot be read", async () => {
        const status = await check({ source: "build", published: IMAGE(NEWER), head: null });

        // Not "up to date": claiming that without having looked is how a
        // deployment sits on an old build believing it is current.
        expect(status.phase).toBe("unknown");
        expect(status.upToDate).toBe(false);
    });
});
