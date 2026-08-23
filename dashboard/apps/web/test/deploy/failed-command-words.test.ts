/**
 * A failed command has to bring its own words back.
 *
 * A deploy of the vision worker stopped like this, and the whole of it was in
 * the log:
 *
 *   b58d72a2e7f2: Pull complete
 *   failed commit on ref "layer-sha256:3db4007...": commit failed: rename
 *   /var/lib/containerd/.../ingest/acc3912.../data
 *   /var/lib/containerd/.../blobs/sha256/3db4007...: no such file or directory
 *
 * What the deployment recorded, and what the screen said, was "the command
 * failed (exit 1)". The streamed command's error carried its exit code and
 * nothing else, so the translation in deploy-failure.ts - which exists to turn
 * exactly that rename into "the machine ran out of disk space" - had nothing to
 * read. Two features that each worked, with the sentence lost between them.
 */

import { describe, expect, it } from "vitest";
import { deployFailureReason } from "@polaris/deploy";
import { lastMeaningfulLine } from "@/lib/deploy/ports-hostd";

/** The pull, as the daemon streamed it. */
const PULL = [
    "latest: Pulling from fjrg2007/polaris-vision",
    "44136fa355b3: Already exists",
    "3db4007d5a31: Pulling fs layer",
    "0ccee8dbeb5e: Pull complete",
    "b58d72a2e7f2: Pull complete",
    [
        'failed commit on ref "layer-sha256:3db4007d5a31": commit failed: rename',
        "/var/lib/containerd/io.containerd.content.v1.content/ingest/acc3912a76a8/data",
        "/var/lib/containerd/io.containerd.content.v1.content/blobs/sha256/3db4007d5a31:",
        "no such file or directory"
    ].join(" "),
    "[polaris:exit:1]"
].join("\n");

describe("what a streamed command said before it gave up", () => {
    it("returns the line that explains it, not the last layer that worked", () => {
        expect(lastMeaningfulLine(PULL)).toContain("failed commit on ref");
    });

    it("never answers with the exit trailer", () => {
        expect(lastMeaningfulLine(PULL)).not.toContain("polaris:exit");
    });

    it("reaches the translation, which is the point of keeping it", () => {
        const said = `the command failed (exit 1): ${lastMeaningfulLine(PULL)}`;
        expect(deployFailureReason(said, "could not pull the image")).toContain(
            "ran out of disk space"
        );
    });

    it("reads a pull that redraws itself over one line", () => {
        // Docker writes progress with carriage returns, so the whole screen is
        // one line until it is split on them too.
        const redrawn = [
            "3db4007d5a31: Downloading  1.2MB/40MB",
            "3db4007d5a31: Downloading  38MB/40MB",
            "3db4007d5a31: Extracting",
            "write /var/lib/docker: no space left on device\n"
        ].join("\r");
        expect(lastMeaningfulLine(redrawn)).toBe("write /var/lib/docker: no space left on device");
    });

    it("falls back to the last line when a command only ever printed progress", () => {
        // Better a layer id than nothing: something failed, and this is all it
        // ever said.
        expect(lastMeaningfulLine("0ccee8dbeb5e: Pull complete\n[polaris:exit:1]\n")).toBe(
            "0ccee8dbeb5e: Pull complete"
        );
    });

    it("says nothing rather than something empty", () => {
        expect(lastMeaningfulLine("")).toBeNull();
        expect(lastMeaningfulLine("  \n\r\n [polaris:exit:1] \n")).toBeNull();
    });

    it("keeps a runaway line short enough to be a message", () => {
        expect(lastMeaningfulLine("x".repeat(5000))?.length).toBe(400);
    });
});
