import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

import { sparseWindowNote } from "@/components/metrics-history";
import { containerMetricSubject } from "@/lib/container-metric-subject";
import { subjectBelongsToOwner } from "@/lib/metrics-history-service";

const say = {
    collectingSince: (at: number) => `since ${at}`,
    nothingYet: "nothing yet"
};

describe("containerMetricSubject", () => {
    it("files a container under the same UUID-shaped subject every tick", () => {
        const id = containerMetricSubject("local", "polaris-web");
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(containerMetricSubject("local", "polaris-web")).toBe(id);
    });

    it("reads a name with Docker's leading slash as the same container", () => {
        expect(containerMetricSubject("local", "/polaris-web")).toBe(
            containerMetricSubject("local", "polaris-web")
        );
    });

    it("keeps the same name on two hosts apart", () => {
        expect(containerMetricSubject("local", "polaris-web")).not.toBe(
            containerMetricSubject("host:0b6f7c1e-0000-4000-8000-000000000001", "polaris-web")
        );
        expect(containerMetricSubject("local", "polaris-web")).not.toBe(
            containerMetricSubject("local", "polaris-db")
        );
    });

    it("is never served on an owner alone", async () => {
        await expect(
            subjectBelongsToOwner("container", containerMetricSubject("local", "polaris-web"), "u")
        ).resolves.toBe(false);
    });
});

describe("sparseWindowNote", () => {
    it("says nothing while the first read is still out", () => {
        expect(sparseWindowNote(null, say)).toBeNull();
    });

    it("says nothing has been recorded for an empty window", () => {
        expect(sparseWindowNote([], say)).toBe("nothing yet");
    });

    it("says when collection started for a single reading", () => {
        expect(sparseWindowNote([{ t: 1_700_000_000_000 }], say)).toBe("since 1700000000000");
    });

    it("steps aside once there is a line to draw", () => {
        expect(sparseWindowNote([{ t: 1 }, { t: 2 }], say)).toBeNull();
    });
});
