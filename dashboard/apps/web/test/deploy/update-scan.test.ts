/**
 * The updates scan: an image service is behind when its tag moved since the
 * release was first seen, a repository service when its branch has commits the
 * release does not, and a registry that cannot be read is never read as current.
 */

import { describe, expect, it, vi } from "vitest";

const { deployFreshness, findMany, update } = vi.hoisted(() => ({
    deployFreshness: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(async () => undefined)
}));
vi.mock("@polaris/db", () => ({ prisma: { application: { findMany, update } } }));
vi.mock("@/lib/deploy/freshness", () => ({ deployFreshness }));

const { checkService, hasUpdate, scanServiceUpdates, splitImageRef } = await import(
    "@/lib/deploy/update-scan"
);

const NOW = new Date("2026-09-10T12:00:00Z");
const image = (ref: string) => ({
    id: "app-1",
    sourceType: "image",
    sourceConfig: JSON.stringify({ imageRef: ref }),
    currentDeploymentId: "dep-1"
});

describe("splitImageRef", () => {
    it("reads the tag, defaults to latest, and leaves a registry port alone", () => {
        expect(splitImageRef("nginx")).toEqual({ image: "nginx", tag: "latest" });
        expect(splitImageRef("ghcr.io/acme/api:v2")).toEqual({
            image: "ghcr.io/acme/api",
            tag: "v2"
        });
        expect(splitImageRef("localhost:5000/api")).toEqual({
            image: "localhost:5000/api",
            tag: "latest"
        });
    });

    it("skips an image pinned by digest, which cannot move", () => {
        expect(splitImageRef("nginx@sha256:abc")).toBeNull();
    });
});

describe("checking an image service", () => {
    it("takes a release seen for the first time to run what its tag is now", async () => {
        const check = await checkService(image("nginx:1.27"), null, NOW, async () => "sha256:a");
        expect(check).toMatchObject({ kind: "image", baseline: "sha256:a", latest: "sha256:a" });
        expect(hasUpdate(check)).toBe(false);
    });

    it("finds an update once the tag points somewhere else", async () => {
        const first = await checkService(image("nginx:1.27"), null, NOW, async () => "sha256:a");
        const later = await checkService(image("nginx:1.27"), first, NOW, async () => "sha256:b");
        expect(later).toMatchObject({ baseline: "sha256:a", latest: "sha256:b" });
        expect(hasUpdate(later)).toBe(true);
    });

    it("starts over for a new release", async () => {
        const behind = await checkService(image("nginx:1.27"), null, NOW, async () => "sha256:a");
        const redeployed = await checkService(
            { ...image("nginx:1.27"), currentDeploymentId: "dep-2" },
            { ...behind!, latest: "sha256:b" },
            NOW,
            async () => "sha256:b"
        );
        expect(redeployed).toMatchObject({ deploymentId: "dep-2", baseline: "sha256:b" });
        expect(hasUpdate(redeployed)).toBe(false);
    });

    it("never reports a registry it could not read as current or as behind", async () => {
        const check = await checkService(
            image("private.example.com/app:1"),
            null,
            NOW,
            async () => {
                throw new Error("401");
            }
        );
        expect(check?.error).toBeTruthy();
        expect(hasUpdate(check)).toBe(false);
    });
});

describe("a whole pass", () => {
    it("asks the registry once per image and tag, however many services run it", async () => {
        const row = (id: string, ref: string) => ({
            ...image(ref),
            id,
            currentDeploymentId: `dep-${id}`,
            updateCheck: null
        });
        findMany.mockResolvedValueOnce([
            row("a", "nginx:1.27"),
            row("b", "docker.io/library/nginx:1.27"),
            row("c", "library/nginx:1.27"),
            row("d", "nginx:1.28"),
            row("e", "ghcr.io/acme/api:v2")
        ]);
        const readDigest = vi.fn(async (_image: string, tag: string) => `sha256:${tag}`);

        await expect(scanServiceUpdates(NOW, readDigest)).resolves.toEqual({
            checked: 5,
            updates: 0
        });
        expect(readDigest).toHaveBeenCalledTimes(3);
        expect(update).toHaveBeenCalledTimes(5);
    });

    it("does not ask again in the same pass for an image the registry refused", async () => {
        const row = (id: string) => ({
            ...image("nginx:1.27"),
            id,
            currentDeploymentId: `dep-${id}`,
            updateCheck: null
        });
        findMany.mockResolvedValueOnce([row("a"), row("b")]);
        const readDigest = vi.fn(async () => {
            throw new Error("toomanyrequests");
        });

        await scanServiceUpdates(NOW, readDigest);
        expect(readDigest).toHaveBeenCalledTimes(1);
    });
});

describe("checking a repository service", () => {
    it("is behind when its branch has commits the release does not", async () => {
        deployFreshness.mockResolvedValueOnce({ branch: "main", behindBy: 3, compareUrl: null });
        const check = await checkService(
            {
                id: "app-2",
                sourceType: "nixpacks",
                sourceConfig: "{}",
                currentDeploymentId: "dep-9"
            },
            null,
            NOW
        );
        expect(check).toMatchObject({ kind: "git", behindBy: 3, branch: "main" });
        expect(hasUpdate(check)).toBe(true);
    });
});
