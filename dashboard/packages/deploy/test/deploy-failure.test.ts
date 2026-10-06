/**
 * What a deploy failure says, and what it means.
 *
 * Every string here came off a real deploy. The one that prompted this is the
 * first: a machine at 97% ran out of room halfway through pulling an image, and
 * what the operator was shown was a rename inside a content-store directory,
 * ending "no such file or directory". That reads like a corrupt image or a bad
 * registry, and it is neither - and somebody without a terminal has no way to
 * reach the real fact at all.
 *
 * The original is always kept, because the translation is for the person
 * reading the log and the original is for whoever has to search for it.
 */

import { describe, expect, it } from "vitest";
import { deployFailureReason, isFetchCutShort, isOutOfSpace } from "../src/deploy-failure.js";

const STEP = "could not pull ghcr.io/example/app:latest";

/** Verbatim, minus the length: the shape is the whole point. A containerd
 *  write that found no room says so in its own words. */
const CONTAINERD_FULL_DISK = `failed commit on ref "layer-sha256:d54b0e95": write /var/lib/containerd/io.containerd.content.v1.content/ingest/3f7c6a40/data: no space left on device`;

/** A layer whose download was removed from under it before it could be filed:
 *  the rename finds nothing to move. Seen on every update of a machine with
 *  5 GB free, beside a prune that ran in the same second. */
const CONTAINERD_CUT_SHORT = `failed commit on ref "index-sha256:a8217ddc": commit failed: rename /var/lib/containerd/io.containerd.content.v1.content/ingest/6ce6cb7e/data /var/lib/containerd/io.containerd.content.v1.content/blobs/sha256/a8217ddc: no such file or directory`;

const CONTAINERD_LCHOWN = `failed to extract layer sha256:0b1c: failed to Lchown "/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/412/fs/usr": no such file or directory`;

describe("a disk with no room left", () => {
    it("is named as one, however the image store phrased it", () => {
        for (const raw of [
            CONTAINERD_FULL_DISK,
            "write /var/lib/docker/tmp/GetImageBlob123: no space left on device",
            "failed to register layer: Error processing tar file(exit status 1): no space left on device",
            "Error: ENOSPC: no space left on device, write"
        ]) {
            expect(deployFailureReason(raw, STEP)).toContain("ran out of disk space");
            // And where to undo it. Polaris frees this itself, so a message that
            // stopped at "free some room" was sending somebody to a terminal for
            // something a button does.
            expect(deployFailureReason(raw, STEP)).toContain("Servers > Storage");
        }
    });

    it("says nothing was deployed, because nothing was", () => {
        expect(deployFailureReason(CONTAINERD_FULL_DISK, STEP)).toContain("Nothing was deployed");
    });

    it("keeps the original for searching", () => {
        expect(deployFailureReason(CONTAINERD_FULL_DISK, STEP)).toContain("failed commit on ref");
    });

    it("can be recognized by a caller that wants to act on it", () => {
        expect(isOutOfSpace(CONTAINERD_FULL_DISK)).toBe(true);
        expect(isOutOfSpace("manifest unknown")).toBe(false);
    });
});

describe("an image taken off the machine while it was coming down", () => {
    it("is not called a full disk, because it is not one", () => {
        for (const raw of [CONTAINERD_CUT_SHORT, CONTAINERD_LCHOWN]) {
            const said = deployFailureReason(raw, STEP);
            expect(said).not.toContain("ran out of disk space");
            expect(said).toContain("removed from the machine while it was being fetched");
            expect(said).toContain("no such file or directory");
            expect(isOutOfSpace(raw)).toBe(false);
            expect(isFetchCutShort(raw)).toBe(true);
        }
    });

    it("is still a full disk when the image store said there was no room", () => {
        expect(isFetchCutShort(CONTAINERD_FULL_DISK)).toBe(false);
    });

    it("is not claimed for an unpack that failed for another reason", () => {
        for (const raw of [
            `failed to extract layer sha256:0b1c: failed to Lchown "/var/lib/containerd/snapshots/412/fs/usr": invalid argument`,
            `failed to extract layer sha256:0b1c: operation not permitted`
        ]) {
            const said = deployFailureReason(raw, STEP);
            expect(said).not.toContain("removed from the machine while it was being fetched");
            expect(said).toBe(raw);
            expect(isFetchCutShort(raw)).toBe(false);
        }
    });
});

describe("the other ways a deploy gives up", () => {
    it("separates an image that is not there from one it may not have", () => {
        expect(deployFailureReason("manifest unknown", STEP)).toContain("does not exist");
        expect(
            deployFailureReason("denied: requested access to the resource is denied", STEP)
        ).toContain("refused the credentials");
    });

    it("calls a registry it could not reach what it is", () => {
        for (const raw of [
            "dial tcp 140.82.121.33:443: i/o timeout",
            "Get https://ghcr.io/v2/: net/http: TLS handshake timeout",
            "temporary failure in name resolution"
        ]) {
            expect(deployFailureReason(raw, STEP)).toContain("could not be reached");
        }
    });

    it("names a port somebody else is already on", () => {
        expect(
            deployFailureReason("Bind for 0.0.0.0:8080 failed: port is already allocated", STEP)
        ).toContain("already using a port");
    });

    it("calls out an image built for another processor", () => {
        expect(deployFailureReason("exec format error", STEP)).toContain("processor");
    });

    it("passes anything it does not recognize through untouched", () => {
        // Guessing at an unknown message is how a log starts lying. The
        // runtime's own words are better than a wrong translation of them.
        expect(deployFailureReason("something entirely new", STEP)).toBe("something entirely new");
    });

    it("names the step when the failure said nothing at all", () => {
        expect(deployFailureReason("   ", STEP)).toBe(STEP);
    });
});
