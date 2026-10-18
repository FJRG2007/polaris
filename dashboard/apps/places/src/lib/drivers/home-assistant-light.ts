/**
 * A Home Assistant light's brightness, colour temperature and colour, read from
 * its state and set through `light.turn_on`.
 *
 * What a light can do is its `supported_color_modes` (Home Assistant's light
 * entity docs): `brightness` dims, `color_temp` also warms, and `hs`, `xy`,
 * `rgb`, `rgbw` or `rgbww` also colour. Anything but `onoff` dims. Brightness
 * is read on Home Assistant's 0-255 scale and written as `brightness_pct`; the
 * temperature is `color_temp_kelvin` within `min_color_temp_kelvin` and
 * `max_color_temp_kelvin`; the colour is `hs_color` (degrees, percent).
 */

import type * as ha from "../integrations/home-assistant-api";
import { percentOf, type LightCommand, type LightSettings } from "../light-kinds";

const COLOR_MODES = ["hs", "xy", "rgb", "rgbw", "rgbww"];

function finite(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** What the light can be set to and is set to, or null for one that only switches. */
export function haLightSettings(entity: ha.HomeAssistantState): LightSettings | null {
    const raw = entity.attributes.supported_color_modes;
    const modes = Array.isArray(raw)
        ? raw.filter((mode): mode is string => typeof mode === "string")
        : [];
    const dims = modes.some((mode) => mode !== "onoff");
    if (!dims) return null;
    const lit = entity.state === "on";
    const brightness = finite(entity.attributes.brightness);
    const min = finite(entity.attributes.min_color_temp_kelvin);
    const max = finite(entity.attributes.max_color_temp_kelvin);
    const warm = modes.includes("color_temp") && min !== null && max !== null && min < max;
    const hs = entity.attributes.hs_color;
    const pair = Array.isArray(hs) && hs.length === 2 ? hs.map(finite) : [null, null];
    return {
        brightness: { level: lit && brightness !== null ? percentOf(brightness, 255) : null },
        temperature: warm
            ? {
                  kelvin: lit ? finite(entity.attributes.color_temp_kelvin) : null,
                  min: min!,
                  max: max!
              }
            : null,
        color: modes.some((mode) => COLOR_MODES.includes(mode))
            ? { hue: lit ? (pair[0] ?? null) : null, saturation: lit ? (pair[1] ?? null) : null }
            : null
    };
}

/** The `light.turn_on` data a command is. */
export function haLightData(command: LightCommand): Record<string, unknown> {
    switch (command.action) {
        case "set-brightness":
            return { brightness_pct: Math.round(command.level) };
        case "set-color-temp":
            return { color_temp_kelvin: Math.round(command.kelvin) };
        case "set-color":
            return { hs_color: [command.hue, command.saturation] };
    }
}
