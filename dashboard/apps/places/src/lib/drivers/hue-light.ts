/**
 * A Hue light's brightness, colour temperature and colour, as the bridge's CLIP
 * v2 light resource carries them: `dimming.brightness` in percent,
 * `color_temperature.mirek` within `mirek_schema`, and `color.xy` in CIE xy.
 */

import type * as hue from "../integrations/hue-api";
import {
    hsToXy,
    kelvinToMireds,
    miredsToKelvin,
    type LightCommand,
    type LightSettings
} from "../light-kinds";

/** What the light can be set to and is set to, or null for one that only switches. */
export function hueLightSettings(light: hue.HueLight): LightSettings | null {
    if (!light.dimming) return null;
    const lit = light.on?.on === true;
    const schema = light.color_temperature?.mirek_schema;
    const mirek = light.color_temperature?.mirek ?? null;
    return {
        brightness: {
            level: lit ? Math.min(100, Math.max(0, Math.round(light.dimming.brightness))) : null
        },
        // The warmest end is the most mirek, so the kelvin range is the other way round.
        temperature:
            schema && schema.mirek_minimum < schema.mirek_maximum
                ? {
                      kelvin: lit && mirek ? miredsToKelvin(mirek) : null,
                      min: miredsToKelvin(schema.mirek_maximum),
                      max: miredsToKelvin(schema.mirek_minimum)
                  }
                : null,
        // The bridge says the colour only as xy; which hue that is is not read back.
        color: light.color ? { hue: null, saturation: null } : null
    };
}

/** The light update body a command is. */
export function hueLightUpdate(command: LightCommand): hue.HueLightUpdate {
    switch (command.action) {
        case "set-brightness":
            return { dimming: { brightness: Math.round(command.level) } };
        case "set-color-temp":
            return { color_temperature: { mirek: kelvinToMireds(command.kelvin) } };
        case "set-color": {
            const [x, y] = hsToXy(command.hue, command.saturation);
            return { color: { xy: { x, y } } };
        }
    }
}
