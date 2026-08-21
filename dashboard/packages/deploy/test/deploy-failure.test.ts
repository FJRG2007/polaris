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
import { deployFailureReason, isOutOfSpace } from "../src/deploy-failure.js";

const STEP = "could not pull ghcr.io/example/app:latest";

/** Verbatim, minus the length: the shape is the whole point. */
const CONTAINERD_FULL_DISK = `failed commit on ref "layer-sha256:d54b0e95": commit failed: rename /var/lib/containerd/io.containerd.content.v1.content/ingest/3f7c6a40/data /var/lib/containerd/io.containerd.content.v1.content/blobs/sha256/d54b0e95: no such file or directory`;

describe("a disk with no room left", () => {
    it("is named as one, however the image store phrased it", () => {
        for (const raw of [
            CONTAINERD_FULL_DISK,
            "write /var/lib/docker/tmp/GetImageBlob123: no space left on device",
            "failed to register layer: Error processing tar file(exit status 1): no space left on device",
            "Error: ENOSPC: no space left on device, write"
        ]) {
            expect(deployFailureReason(raw, STEP)).toContain("ran out of disk space");
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

describe("the other ways a deploy gives up", () => {
    it("separates an image that is not there from one it may not have", () => {
        expect(deployFailureReason("manifest unknown", STEP)).toContain("does not exist");
        expect(deployFailureReason("denied: requested access to the resource is denied", STEP)).toContain(
            "refused the credentials"
        );
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
