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
            return key === "fill"
                ? () => {
                      fills += 1;
                  }
                : () => undefined;
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
