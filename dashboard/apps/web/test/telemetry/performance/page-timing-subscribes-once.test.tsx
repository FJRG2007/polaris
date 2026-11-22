// @vitest-environment jsdom
/**
 * The Web Vitals report function keeps one identity for the life of the page.
 * `useReportWebVitals` subscribes again whenever it changes and the library
 * never unsubscribes, so a new function per render piled up document listeners
 * and performance observers on every navigation - thousands in a desktop window
 * left open for hours, all run on every click and key.
 */

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const path = vi.hoisted(() => ({ current: "/home" }));
const given = vi.hoisted(() => [] as unknown[]);

vi.mock("next/navigation", () => ({ useRouter: () => ({ prefetch: () => {} }), usePathname: () => path.current }));
vi.mock("next/web-vitals", () => ({ useReportWebVitals: (report: unknown) => void given.push(report) }));

const { PageTiming } = await import("@/components/telemetry/page-timing");

describe("page timing", () => {
    it("hands the same report function on every render and navigation", () => {
        const view = render(<PageTiming />);
        for (const next of ["/chat", "/drive", "/polar", "/home"]) {
            path.current = next;
            view.rerender(<PageTiming />);
        }
        expect(given.length).toBeGreaterThan(1);
        expect(new Set(given).size).toBe(1);
    });
});
