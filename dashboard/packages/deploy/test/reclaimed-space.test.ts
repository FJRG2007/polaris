/**
 * Reading how much room a prune handed back.
 *
 * This is prose parsing, which is only ever done under protest - the local daemon
 * answers with a number and a machine reached over SSH prints a sentence. It
 * matters because the number decides whether a failed deploy is retried: nothing
 * freed means telling the operator their disk is genuinely full, and gigabytes
 * freed means trying again without bothering anybody.
 */

import { describe, expect, it } from "vitest";
import { parseReclaimedBytes } from "../src/deploy-failure.js";

describe("parseReclaimedBytes", () => {
    it("reads what a prune actually says", () => {
        expect(parseReclaimedBytes("Total reclaimed space: 1.271GB")).toBe(1_271_000_000);
        expect(parseReclaimedBytes("Total reclaimed space: 512MB")).toBe(512_000_000);
        expect(parseReclaimedBytes("Total reclaimed space: 0B")).toBe(0);
    });

    it("sums the two prunes a sweep runs, which each print their own line", () => {
        const said = [
            "Deleted build cache objects:",
            "vv7q1ne1qxk2s2m4o5p6",
            "Total reclaimed space: 2.5GB",
            "Deleted Images:",
            "untagged: ghcr.io/example/thing:latest",
            "Total reclaimed space: 700MB"
        ].join("\n");
        expect(parseReclaimedBytes(said)).toBe(3_200_000_000);
    });

    it("tells the binary units from the decimal ones rather than treating them alike", () => {
        expect(parseReclaimedBytes("Total reclaimed space: 1GiB")).toBe(1_073_741_824);
        expect(parseReclaimedBytes("Total reclaimed space: 1GB")).toBe(1_000_000_000);
    });

    it("reads it however the machine spaced and cased it", () => {
        expect(parseReclaimedBytes("total reclaimed space:4.2gb")).toBe(4_200_000_000);
    });

    it("says nothing was freed rather than guessing, when it cannot read the line", () => {
        expect(parseReclaimedBytes("Total reclaimed space: heaps")).toBe(0);
        expect(parseReclaimedBytes("Error: Cannot connect to the Docker daemon")).toBe(0);
        expect(parseReclaimedBytes("")).toBe(0);
    });

    it("ignores a line that is talking about something else entirely", () => {
        expect(parseReclaimedBytes("Total disk space: 40GB\nnothing was pruned")).toBe(0);
    });
});
