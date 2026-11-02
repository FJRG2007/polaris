/**
 * Where the main window goes when the app opens: where it was, unless that place no
 * longer exists. A monitor can be unplugged between runs, and a window restored onto
 * it would be open and impossible to reach, so what was saved is only used while its
 * title bar can still be grabbed on some display.
 */

export interface Area {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface WindowPlace extends Area {
    readonly maximized: boolean;
}

/** How much of the top of a window has to be on a display to reach it, in pixels. */
const GRAB_WIDTH = 120;
const GRAB_HEIGHT = 32;

function overlap(from: number, size: number, areaFrom: number, areaSize: number): number {
    return Math.min(from + size, areaFrom + areaSize) - Math.max(from, areaFrom);
}

function reachableOn(place: Area, area: Area): boolean {
    return (
        overlap(place.x, place.width, area.x, area.width) >= GRAB_WIDTH &&
        overlap(place.y, GRAB_HEIGHT, area.y, area.height) >= GRAB_HEIGHT
    );
}

/** What to open with. No `x` and `y` leaves the system to centre it. */
export function restoredPlace(
    saved: WindowPlace,
    displays: readonly Area[],
    primary: Area
): { width: number; height: number; x?: number; y?: number; maximized: boolean; } {
    const on = displays.find((area) => reachableOn(saved, area));
    const { width, height, maximized } = saved;
    if (on) return { x: saved.x, y: saved.y, width, height, maximized };
    return {
        width: Math.min(width, primary.width),
        height: Math.min(height, primary.height),
        maximized
    };
}
