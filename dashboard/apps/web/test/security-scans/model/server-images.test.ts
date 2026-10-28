/**
 * Every image on a server from its container listing: grouped by image id so
 * one image is scanned once, and told apart by who runs it. Listings below are
 * fixture data shaped like the engine's answers.
 */

import { describe, expect, it } from "vitest";
import * as images from "@polaris-app/security-scans/src/model/images";

const id = (digit: string) => `sha256:${digit.repeat(64)}`;

const DAEMON_FIXTURE = [
    {
        Names: ["/polaris-web-1"],
        Image: "ghcr.io/example/polaris-web:fixture",
        ImageID: id("a"),
        Labels: { "com.docker.compose.project": "polaris", "com.docker.compose.service": "web" }
    },
    {
        Names: ["/polaris-edge-guard-1"],
        Image: "ghcr.io/example/polaris-edge-guard:fixture",
        ImageID: id("b"),
        Labels: {
            "com.docker.compose.project": "polaris",
            "com.docker.compose.service": "edge-guard"
        }
    },
    {
        Names: ["/polaris-0123abcd-web-1"],
        Image: "polaris-0123abcd:fixture-release",
        ImageID: id("c"),
        Labels: { "com.docker.compose.project": "polaris-0123abcd" }
    },
    {
        Names: ["/polaris-0123abcd-worker-1"],
        Image: "polaris-0123abcd:fixture-release",
        ImageID: id("c"),
        Labels: { "com.docker.compose.project": "polaris-0123abcd" }
    },
    {
        Names: ["/fixture-session"],
        Image: "node:22-bookworm",
        ImageID: id("d"),
        Labels: { "polaris.agent-session": "fixture-session-id" }
    },
    { Names: ["/polaris-secscan-image-x"], Image: "anchore/grype", ImageID: id("e"), Labels: {} },
    { Names: ["/not-valid"], Image: "fixture", ImageID: "not-a-digest", Labels: {} },
    "garbage"
];

describe("server images", () => {
    const listed = images.fromDaemonListing(DAEMON_FIXTURE);

    it("drops listing rows that do not parse", () => {
        expect(listed).toHaveLength(6);
    });

    it("scans one image once however many containers run it", () => {
        const grouped = images.groupImages(listed, new Map([["polaris-0123abcd", "Fixture shop"]]));
        expect(grouped.map((image) => [image.source, image.ref, image.users])).toEqual([
            ["polaris", "ghcr.io/example/polaris-edge-guard:fixture", ["edge-guard"]],
            ["polaris", "ghcr.io/example/polaris-web:fixture", ["web"]],
            ["app", "polaris-0123abcd:fixture-release", ["Fixture shop"]],
            ["agent", "node:22-bookworm", ["fixture-session"]]
        ]);
    });

    it("names the Deploy apps that run an image, so its findings link to them", () => {
        const grouped = images.groupImages(
            listed,
            new Map([["polaris-0123abcd", "Fixture shop"]]),
            new Map([["polaris-0123abcd", "fixture-app-id"]])
        );
        expect(grouped.map((image) => [image.source, image.applicationIds])).toEqual([
            ["polaris", []],
            ["polaris", []],
            ["app", ["fixture-app-id"]],
            ["agent", []]
        ]);
    });

    it("counts a part of Polaris run as an app as Polaris's own, under the app's name", () => {
        const grouped = images.groupImages(
            listed,
            new Map([["polaris-0123abcd", "Camera relay"]]),
            new Map([["polaris-0123abcd", "fixture-app-id"]]),
            new Set(["polaris-0123abcd"])
        );
        const relay = grouped.find((image) => image.ref === "polaris-0123abcd:fixture-release");
        expect(relay).toMatchObject({
            source: "polaris",
            users: ["Camera relay"],
            applicationIds: ["fixture-app-id"],
            part: "fixture-app-id"
        });
        expect(images.groupImages(listed, new Map(), new Map()).some((i) => "part" in i)).toBe(
            false
        );
    });

    it("counts an image Polaris also runs as Polaris's own", () => {
        const shared = images.groupImages(
            [
                {
                    name: "x",
                    ref: "node:22",
                    imageId: id("f"),
                    project: "polaris-0123abcd",
                    labels: {}
                },
                { name: "y", ref: "node:22", imageId: id("f"), project: "polaris", labels: {} }
            ],
            new Map()
        );
        expect(shared).toHaveLength(1);
        expect(shared[0]!.source).toBe("polaris");
    });

    it("never takes a prefix for Polaris's own project", () => {
        expect(
            images.sourceOf({
                name: "",
                ref: "",
                imageId: id("1"),
                project: "polaris-extra",
                labels: {}
            })
        ).toBe("other");
    });

    it("reads the CLI listing over SSH the same way", () => {
        const container = "1".repeat(64);
        const ps = `${container}\tnode:22\tfixture-app\tpolaris-0123abcd\tcom.docker.compose.project=polaris-0123abcd,other=1\nbroken line`;
        const inspect = `${container}\t${id("9")}\n`;
        expect(images.fromCliListing(ps, inspect)).toEqual([
            {
                name: "fixture-app",
                ref: "node:22",
                imageId: id("9"),
                project: "polaris-0123abcd",
                labels: { "com.docker.compose.project": "polaris-0123abcd", other: "1" }
            }
        ]);
    });
});
