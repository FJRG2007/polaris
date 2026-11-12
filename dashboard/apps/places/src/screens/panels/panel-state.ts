/**
 * What a press does to the device a wall shows before anything answers, and
 * how it is put back when the answer is a refusal. The same rule the devices
 * screen follows (`use-device-act`), pure so the wall's link mode - which has
 * no server action to call - draws a press the same way and can be tested.
 */

import * as kinds from "../../lib/device-kinds";
import { applyDeviceChange, type DeviceChange } from "../../lib/device-diff";
import type { DeviceAction, DeviceCommand, DeviceView } from "../../lib/device-kinds";
import type { PanelAccent, PanelStyle, PanelTheme } from "../../lib/panel-layout";

/** The device as it reads the moment it is pressed, or null where the outcome
 *  is the vendor's to report (a lock turning). */
export function optimisticDevice(
    device: DeviceView,
    action: DeviceAction,
    command?: DeviceCommand
): DeviceView | null {
    if (command) {
        const applied = kinds.applyCommand(
            {
                kind: device.kind,
                climate: device.climate ?? null,
                air: device.air ?? null,
                light: device.light ?? null
            },
            command
        );
        if (applied && "climate" in applied && device.climate)
            return { ...device, climate: { ...device.climate, ...applied.climate } };
        if (applied && "air" in applied) return { ...device, air: applied.air };
        if (applied && "light" in applied) return { ...device, light: applied.light };
        return null;
    }
    const settled = kinds.settledState(action);
    return settled ? { ...device, state: settled } : null;
}

/**
 * The entry once a press was refused: what it was before the press, but only
 * while it is still what the press made it. A later press, or a live update,
 * has won since and is kept.
 */
export function rolledBack(entry: DeviceView, before: DeviceView, pressed: DeviceView): DeviceView {
    if (entry.id !== before.id || entry !== pressed) return entry;
    return before;
}

/** A live frame applied to the devices a panel shows. A device that is not on
 *  the panel is never added by a frame: the panel decides what it shows. */
export function applyPanelChange(
    current: readonly DeviceView[],
    change: Pick<DeviceChange, "devices" | "removed">
): DeviceView[] {
    const known = new Set(current.map((device) => device.id));
    return (
        applyDeviceChange(current, {
            devices: change.devices.filter((device) => known.has(device.id)),
            removed: change.removed
        }) ?? [...current]
    );
}

/** Whether it is night by the wall's own clock: nine in the evening to seven
 *  in the morning. */
export function isNight(date: Date): boolean {
    const hour = date.getHours();
    return hour >= 21 || hour < 7;
}

/** The theme a wall shows now: dark at night when asked, the panel's own
 *  theme otherwise ("auto" is the reader's). */
export function wallTheme(theme: PanelTheme, nightDark: boolean, date: Date): PanelTheme {
    return nightDark && isNight(date) ? "dark" : theme;
}

/** Each accent's colour, as the theme's tokens write one (hue saturation
 *  lightness). "default" keeps the theme's own. */
export const ACCENT_HSL: Readonly<Record<Exclude<PanelAccent, "default">, string>> = {
    blue: "217 91% 60%",
    teal: "173 80% 40%",
    green: "142 71% 45%",
    amber: "38 92% 50%",
    rose: "350 89% 60%"
};

/** The custom properties and background a wall is drawn with. */
export function wallSurface(style: Pick<PanelStyle, "accent" | "background">): {
    [name: string]: string;
} {
    const surface: { [name: string]: string } = {};
    if (style.accent !== "default") {
        surface["--primary"] = ACCENT_HSL[style.accent];
        surface["--ring"] = ACCENT_HSL[style.accent];
    }
    if (style.background === "tinted")
        surface.background =
            "linear-gradient(hsl(var(--primary) / 0.08), hsl(var(--primary) / 0.08)), hsl(var(--background))";
    if (style.background === "gradient")
        surface.background =
            "radial-gradient(120% 90% at 0% 0%, hsl(var(--primary) / 0.22), transparent 60%), radial-gradient(90% 80% at 100% 100%, hsl(var(--primary) / 0.12), transparent 55%), hsl(var(--background))";
    return surface;
}

/** Row height, gap and card padding of each density, in rem. */
export const DENSITY = {
    comfortable: { row: 5.5, gap: 0.75, pad: 1 },
    compact: { row: 4.5, gap: 0.5, pad: 0.75 }
} as const;

/**
 * Where the screensaver's clock sits at a step, as percentages of the screen
 * from its top left corner: a new spot every step, never near an edge, and
 * the same spot for the same step so it can be tested. Moving the only lit
 * pixels is what keeps them from burning in.
 */
export function driftPosition(step: number): { left: number; top: number } {
    const noise = (seed: number) => {
        const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
        return value - Math.floor(value);
    };
    return {
        left: Math.round((25 + noise(step) * 50) * 10) / 10,
        top: Math.round((25 + noise(step + 0.5) * 50) * 10) / 10
    };
}
