import { beforeEach, describe, expect, it, vi } from "vitest";
import * as image from "../../src/lib/agents/session-image";

const DAY = image.SESSION_IMAGE_REFRESH_MS;

describe("session image refresh", () => {
    beforeEach(() => {
        image.resetSessionImageRefresh();
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    it("asks the registry when the image was never refreshed or the day is over", () => {
        expect(image.sessionPullPolicy(null, 1_000)).toBe("always");
        expect(image.sessionPullPolicy(0, DAY)).toBe("always");
        expect(image.sessionPullPolicy(0, DAY - 1)).toBe("missing");
    });

    it("pulls once a day and uses the cached image in between", async () => {
        const up = vi.fn(async () => undefined);
        let now = 10;
        await image.upWithFreshImage(up, () => now);
        now += DAY - 1;
        await image.upWithFreshImage(up, () => now);
        now += 2;
        await image.upWithFreshImage(up, () => now);
        expect(up.mock.calls.map((call) => call[0])).toEqual(["always", "missing", "always"]);
    });

    it("starts on the cached image when the pull fails, and tries again next time", async () => {
        const up = vi.fn(async (policy: string) => {
            if (policy === "always") throw new Error("registry unreachable");
        });
        await image.upWithFreshImage(up, () => 10);
        await image.upWithFreshImage(up, () => 20);
        expect(up.mock.calls.map((call) => call[0])).toEqual([
            "always",
            "missing",
            "always",
            "missing"
        ]);
    });

    it("does not hide a failure of the cached image itself", async () => {
        const up = vi.fn(async () => {
            throw new Error("no such image");
        });
        await expect(image.upWithFreshImage(up, () => 10)).rejects.toThrow("no such image");
    });
});
