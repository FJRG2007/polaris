/**
 * A scan's subject is shown and announced under its name of today: the
 * Network filter's DNS server was installed as "Ad blocker DNS server", and an
 * alert about it said so after the rename. Its outcome reads as one line.
 */

import { describe, expect, it } from "vitest";
import * as subjects from "@polaris-app/security-scans/src/model/subjects";

const MANIFESTS: Record<string, subjects.ManifestName> = {
    "dns-blocker": { name: "Network filter", opensAt: "/apps/dns-blocker" },
    "dns-blocker-engine": {
        name: "Network filter DNS server",
        internal: true,
        ownedBy: "dns-blocker"
    },
    minecraft: { name: "Minecraft" }
};
const find = (id: string) => MANIFESTS[id];

describe("currentApp", () => {
    it("names an app Polaris installed for itself by the catalog's current name", () => {
        const app = subjects.currentApp(
            {
                id: "a1",
                name: "Ad blocker DNS server",
                projectId: "p1",
                installed: { id: "i1", catalogId: "dns-blocker-engine" }
            },
            find
        );
        expect(app).toEqual({ name: "Network filter DNS server", href: "/apps/dns-blocker" });
    });

    it("keeps the name an operator gave their own install, and links to it", () => {
        const app = subjects.currentApp(
            {
                id: "a2",
                name: "Survival",
                projectId: "p1",
                installed: { id: "i2", catalogId: "minecraft" }
            },
            find
        );
        expect(app).toEqual({ name: "Survival", href: "/apps/installed/i2" });
    });

    it("links a plain Deploy app to its service in the project", () => {
        expect(
            subjects.currentApp({ id: "a3", name: "api", projectId: "p9", installed: null }, find)
        ).toEqual({ name: "api", href: "/apps/deploy/p9?service=a3" });
    });

    it("has no link when the app has nowhere to open", () => {
        expect(
            subjects.currentApp({ id: "a4", name: "x", projectId: null, installed: null }, find)
                .href
        ).toBeNull();
    });
});

describe("subjectName", () => {
    const apps = new Map([["a1", { name: "Network filter DNS server", href: null }]]);

    it("uses the app's current name over the one stored with the scan", () => {
        expect(
            subjects.subjectName(
                { label: "Ad blocker DNS server", input: { applicationId: "a1" } },
                apps
            )
        ).toBe("Network filter DNS server");
    });

    it("falls back to the stored label for a removed app or an image with no app", () => {
        expect(
            subjects.subjectName({ label: "Old app", input: { applicationId: "gone" } }, apps)
        ).toBe("Old app");
        expect(
            subjects.subjectName({ label: "nginx:1.27", input: { imageId: "sha256:x" } }, apps)
        ).toBe("nginx:1.27");
    });
});

describe("subjectKind", () => {
    it("tells an app's image, a server image and dependencies apart", () => {
        expect(subjects.subjectKind({ kind: "image", input: { applicationId: "a" } })).toBe(
            "appImage"
        );
        expect(subjects.subjectKind({ kind: "image", input: { imageId: "sha256:x" } })).toBe(
            "image"
        );
        expect(subjects.subjectKind({ kind: "deps", input: { applicationId: "a" } })).toBe("deps");
    });
});

describe("verdictOf and nextStep", () => {
    const summary = { critical: 1, high: 12, medium: 0, low: 0, total: 13 };

    it("counts what was found, worst first, leaving out the empty severities", () => {
        expect(subjects.verdictOf(summary)).toEqual({
            total: 13,
            parts: [
                { severity: "critical", count: 1 },
                { severity: "high", count: 12 }
            ],
            fixable: null
        });
    });

    it("says every one is fixed by updating when each has a fixed version", () => {
        const findings = Array.from({ length: 13 }, (_, i) => ({
            severity: i === 0 ? "critical" : "high",
            fixedIn: "1.27.2"
        }));
        const verdict = subjects.verdictOf(summary, findings);
        expect(verdict.fixable).toBe(13);
        expect(subjects.nextStep(verdict)).toBe("update");
    });

    it("says to wait when none has a fix, and to update some when some do", () => {
        const none = subjects.verdictOf(summary, [{ severity: "critical", fixedIn: null }]);
        expect(subjects.nextStep(none)).toBe("wait");
        const some = subjects.verdictOf(summary, [{ severity: "critical", fixedIn: "2" }]);
        expect(subjects.nextStep(some)).toBe("updateSome");
    });

    it("has nothing to do for a clean scan or a summary that is not counts", () => {
        expect(subjects.nextStep(subjects.verdictOf({}))).toBe("none");
        expect(subjects.verdictOf({ critical: "x", high: -2 })).toEqual({
            total: 0,
            parts: [],
            fixable: null
        });
    });
});
