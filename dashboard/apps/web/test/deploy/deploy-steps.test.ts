/**
 * The deploy stepper reads where a deploy is from what it already wrote.
 *
 * The logs here are shaped the way the compose runtime writes them, so a
 * change to those lines that would blank the stepper fails here first.
 */

import { describe, expect, it } from "vitest";
import { deploySteps, type DeployStepState } from "@/lib/deploy/deploy-steps";

const states = (status: string, log: string): Record<string, DeployStepState> =>
    Object.fromEntries(deploySteps(status, log).map((step) => [step.id, step.state]));

const BUILD_LOG = [
    "==> Fetching the source...",
    "Cloning as someone.",
    "==> Fetching the source: 2.1s",
    "==> Building the image...",
    "#1 [internal] load build definition",
    "==> Building the image: 48.0s",
    "Kept this release as polaris-release/shop-web-1a2b:0123456789ab, so it can be rolled back to.",
    "==> Starting the containers...",
    "==> Starting the containers: 3.2s",
    ""
].join("\n");

describe("a build from a repository", () => {
    it("is all done once it is running, with how long each step took", () => {
        const steps = deploySteps("running", BUILD_LOG);
        expect(steps.map((step) => step.state)).toEqual(["done", "done", "done", "done", "done", "done"]);
        expect(steps.find((step) => step.id === "build")?.seconds).toBe(48);
        expect(steps.find((step) => step.id === "source")?.label).toBe("Clone");
    });

    it("marks the step it is on while it is on it", () => {
        const midway = BUILD_LOG.split("==> Building the image: 48.0s")[0]!;
        expect(states("deploying", midway)).toMatchObject({
            queued: "done",
            source: "done",
            build: "current",
            keep: "pending",
            live: "pending"
        });
    });

    it("puts a failure on the step that was running", () => {
        const failedBuild = "==> Fetching the source...\n==> Fetching the source: 1.0s\n==> Building the image...\n==> Failed: the image would not build\n";
        expect(states("failed", failedBuild)).toMatchObject({ source: "done", build: "failed", start: "pending" });
    });
});

describe("an image, and a rollback", () => {
    it("skips the build for a pulled image", () => {
        const log = "==> Pulling ghcr.io/acme/web:1.2...\n==> Pulling ghcr.io/acme/web:1.2: 4.5s\n==> Starting the containers...\n==> Starting the containers: 1.0s\n";
        expect(states("running", log)).toMatchObject({ source: "done", build: "skipped", start: "done", live: "done" });
        expect(deploySteps("running", log).find((step) => step.id === "source")?.label).toBe("Pull");
    });

    it("draws a rollback as a kept image with nothing built", () => {
        const log = "Rolling back to the kept image polaris-release/web:0123456789ab - nothing is fetched or built.\n==> Starting the containers...\n";
        expect(states("deploying", log)).toMatchObject({ source: "done", build: "skipped", keep: "done", start: "current" });
    });

    it("warns when the release could not be kept", () => {
        const log = "==> Pulling nginx:alpine...\n==> Pulling nginx:alpine: 1.0s\n[warn] This release could not be kept for an instant rollback (no builder). It is deployed all the same.\n==> Starting the containers...\n==> Starting the containers: 1.0s\n";
        expect(states("running", log).keep).toBe("warning");
    });
});

describe("a deploy with no step lines", () => {
    it("is drawn from its status alone", () => {
        expect(states("queued", "")).toMatchObject({ queued: "current", live: "pending" });
        expect(Object.values(states("running", ""))).toEqual(["done", "done", "done", "done", "done", "done"]);
        expect(states("failed", "")).toMatchObject({ queued: "done", source: "failed" });
    });
});
