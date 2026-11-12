// @vitest-environment jsdom

/**
 * The bar under a running update: the share of the estimate gone by and the time
 * left, and "taking longer than usual" past it rather than a frozen 99%.
 */

import { withMessages } from "../setup/i18n";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UpdateProgress } from "@/app/(app)/admin/updates/update-progress";

const MIN = 60_000;

afterEach(cleanup);

function bar(elapsed: number, estimateMs = 4 * MIN, skew = 0) {
    const startedAt = 10_000_000;
    render(withMessages(<UpdateProgress run={{ startedAt, estimateMs, skew }} now={startedAt + skew + elapsed} />));
    return screen.getByRole("progressbar");
}

describe("UpdateProgress", () => {
    it("shows the share elapsed and the minutes left", () => {
        const progress = bar(2 * MIN);
        expect(progress.getAttribute("aria-valuenow")).toBe("47");
        expect(screen.getByText("About 2 minutes left")).toBeTruthy();
    });

    it("measures on the server's clock, not this browser's", () => {
        expect(bar(MIN, 4 * MIN, 90_000).getAttribute("aria-valuenow")).toBe("23");
    });

    it("says under a minute near the end", () => {
        bar(3.5 * MIN);
        expect(screen.getByText("Less than a minute left")).toBeTruthy();
    });

    it("says it is taking longer once past the estimate, and stays short of done", () => {
        const progress = bar(10 * MIN);
        expect(Number(progress.getAttribute("aria-valuenow"))).toBeLessThan(100);
        expect(screen.getByText("Taking longer than usual")).toBeTruthy();
    });
});
