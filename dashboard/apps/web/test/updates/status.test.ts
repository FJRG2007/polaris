/**
 * What the update card is told.
 *
 * The rule under test is that an update means a published image, not a commit: CI
 * needs minutes to build one, and offering an update in that window produced a
 * pull that changed nothing and a card that kept offering it. So a branch that has
 * moved ahead of the registry is "building", not "available", and only an image
 * whose commit differs from the running one is an update.
 *
 * The other half is that GitHub is optional. It supplies the commit count and the
 * building hint; when it is rate-limited or unreachable the registry alone still
 * has to produce a correct answer.
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
    readonly files?: { filename: string }[];
}

async function check(options: {
    running?: string;
    published: PublishedImage;
    compare?: Compare | null;
}): Promise<UpdateStatus> {
    vi.resetModules();
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
        vi.fn(async () =>
            options.compare
                ? new Response(JSON.stringify(options.compare), { status: 200 })
                : new Response("rate limited", { status: 403 })
        )
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
