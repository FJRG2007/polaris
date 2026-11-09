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

    it("starts on the machine's image and refreshes it behind the start, once a day", async () => {
        const up = vi.fn(async () => undefined);
        const refresh = vi.fn(async () => undefined);
        let now = 10;
        await image.upWithFreshImage(up, refresh, () => now);
        await image.sessionImageRefreshing();
        now += DAY - 1;
        await image.upWithFreshImage(up, refresh, () => now);
        now += 2;
        await image.upWithFreshImage(up, refresh, () => now);
        await image.sessionImageRefreshing();
        expect(up.mock.calls.map((call) => call[0])).toEqual(["missing", "missing", "missing"]);
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it("never waits for the refresh before the session is up", async () => {
        let release = () => undefined as void;
        const refresh = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
        const up = vi.fn(async () => undefined);
        // Resolves although the pull has not finished.
        await image.upWithFreshImage(up, refresh, () => 10);
        expect(up).toHaveBeenCalledWith("missing");
        expect(refresh).toHaveBeenCalledTimes(1);
        // A second start while it runs does not start a second pull.
        await image.upWithFreshImage(up, refresh, () => 20);
        expect(refresh).toHaveBeenCalledTimes(1);
        release();
        await image.sessionImageRefreshing();
    });

    it("tries a failed refresh again on the next start", async () => {
        const up = vi.fn(async () => undefined);
        const refresh = vi.fn(async () => {
            throw new Error("registry unreachable");
        });
        await image.upWithFreshImage(up, refresh, () => 10);
        await image.sessionImageRefreshing();
        await image.upWithFreshImage(up, refresh, () => 20);
        await image.sessionImageRefreshing();
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(up.mock.calls.map((call) => call[0])).toEqual(["missing", "missing"]);
    });

    it("does not hide a failure of the start itself", async () => {
        const up = vi.fn(async () => {
            throw new Error("no such image");
        });
        await expect(image.upWithFreshImage(up, async () => undefined, () => 10)).rejects.toThrow(
            "no such image"
        );
    });
});
