/**
 * jsdom has no 2D canvas. A context whose every method does nothing and
 * counts its fills is enough to show a frame was painted.
 */

import { vi } from "vitest";

export function stubCanvas(): { fills: () => number } {
    let fills = 0;
    const ctx = new Proxy({} as Record<string | symbol, unknown>, {
        get(target, key) {
            if (key in target) return target[key];
            if (key === "fill")
                return () => {
                    fills += 1;
                };
            // A gradient that takes its stops and draws nothing.
            if (key === "createLinearGradient" || key === "createRadialGradient")
                return () => ({ addColorStop: () => undefined });
            return () => undefined;
        },
        set(target, key, value) {
            target[key] = value;
            return true;
        }
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
        () => ctx as unknown as CanvasRenderingContext2D
    );
    return { fills: () => fills };
}
