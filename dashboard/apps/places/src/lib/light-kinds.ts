/**
 * What a light can be set to beyond on and off: how bright, how warm, what
 * colour.
 *
 * Pure and client-safe, like `air-kinds`: the devices screen, the overview card
 * and the service all read the same rules, so a slider is drawn only for a
 * light that has one and the service refuses what the light cannot do.
 */

import { z } from "zod";

/** Kelvin a light is believed when it states its own range: anything past this
 *  is a misread, not a bulb. */
const KELVIN_FLOOR = 1000;
const KELVIN_CEILING = 12_000;

const percent = z.number().finite().min(0).max(100);
const kelvin = z.number().finite().min(KELVIN_FLOOR).max(KELVIN_CEILING);
const hue = z.number().finite().min(0).max(360);

/**
 * How a light is set and what it can be set to.
 *
 * Stored on the device row as one document, refreshed by every sync. A part is
 * present only when the light has it: `brightness` is null on a light that
 * only switches, `temperature` on one with a fixed white, `color` on one that
 * is not coloured. `level` is the brightness it last reported, in percent.
 */
export const lightSettingsSchema = z.object({
    brightness: z.object({ level: percent.nullable() }).nullable(),
    temperature: z
        .object({ kelvin: kelvin.nullable(), min: kelvin, max: kelvin })
        .refine((range) => range.min < range.max)
        .nullable(),
    color: z.object({ hue: hue.nullable(), saturation: percent.nullable() }).nullable()
});

export type LightSettings = z.infer<typeof lightSettingsSchema>;

/** Stored settings, read back, or null for anything that is not them. */
export function lightSettings(value: unknown): LightSettings | null {
    const parsed = lightSettingsSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/** Settings as a driver reported them, made fit to store: a light that has none
 *  of the three is stored as nothing, the way a plain switch is. */
export function storableLight(settings: LightSettings | null | undefined): LightSettings | null {
    if (!settings) return null;
    const read = lightSettings(settings);
    if (!read || (!read.brightness && !read.temperature && !read.color)) return null;
    return read;
}

/** One change to a light. Zero brightness is not a level: it is `turn-off`. */
export const lightCommandSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("set-brightness"), level: z.number().finite().min(1).max(100) }),
    z.object({ action: z.literal("set-color-temp"), kelvin }),
    z.object({ action: z.literal("set-color"), hue, saturation: percent })
]);

export type LightCommand = z.infer<typeof lightCommandSchema>;

/** Why a command cannot go to this light, or null when it can. */
export function lightCommandIssue(
    settings: LightSettings | null,
    command: LightCommand
): string | null {
    if (!settings) return "That light has not said what it can be set to yet";
    switch (command.action) {
        case "set-brightness":
            return settings.brightness ? null : "That light does not dim";
        case "set-color-temp": {
            const range = settings.temperature;
            if (!range) return "That light has no color temperature to change";
            return command.kelvin >= range.min && command.kelvin <= range.max
                ? null
                : "That color temperature is not one this light accepts";
        }
        case "set-color":
            return settings.color ? null : "That light has no color to change";
    }
}

/** The settings once a command has landed: what the row shows the moment it is
 *  pressed. A colour and a white are one choice on the bulb, so picking one
 *  leaves the other unknown until the light says what it is showing. */
export function applyLight(settings: LightSettings, command: LightCommand): LightSettings {
    switch (command.action) {
        case "set-brightness":
            return settings.brightness
                ? { ...settings, brightness: { level: command.level } }
                : settings;
        case "set-color-temp":
            return settings.temperature
                ? {
                      ...settings,
                      temperature: { ...settings.temperature, kelvin: command.kelvin },
                      color: settings.color ? { hue: null, saturation: null } : null
                  }
                : settings;
        case "set-color":
            return settings.color
                ? {
                      ...settings,
                      color: { hue: command.hue, saturation: command.saturation },
                      temperature: settings.temperature
                          ? { ...settings.temperature, kelvin: null }
                          : null
                  }
                : settings;
    }
}

// --- conversions the drivers share --------------------------------------------

/** A level on a 0..`scale` wire (Hue's 254, Home Assistant's 255) as percent,
 *  never 0 for a light that is lit. */
export function percentOf(value: number, scale: number): number {
    const level = Math.round((value / scale) * 100);
    return Math.min(100, Math.max(value > 0 ? 1 : 0, level));
}

/** Percent on a 0..`scale` wire, never 0: zero is off, which is its own action. */
export function scaleOf(percentLevel: number, scale: number): number {
    return Math.min(scale, Math.max(1, Math.round((percentLevel / 100) * scale)));
}

/** Mireds (micro reciprocal degrees, what Hue and MQTT lights speak) and
 *  kelvin are each other's reciprocal over a million. */
export function miredsToKelvin(mireds: number): number {
    return Math.round(1_000_000 / mireds);
}

export function kelvinToMireds(value: number): number {
    return Math.round(1_000_000 / value);
}

/** A hue (degrees) and saturation (percent) as RGB 0..255, full value. */
export function hsToRgb(hueDegrees: number, saturation: number): [number, number, number] {
    const s = saturation / 100;
    const f = (n: number) => {
        const k = (n + hueDegrees / 60) % 6;
        return 1 - s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

/** RGB 0..255 as hue (degrees) and saturation (percent). */
export function rgbToHs(
    red: number,
    green: number,
    blue: number
): { hue: number; saturation: number } {
    const r = red / 255;
    const g = green / 255;
    const b = blue / 255;
    const max = Math.max(r, g, b);
    const delta = max - Math.min(r, g, b);
    let degrees = 0;
    if (delta > 0) {
        if (max === r) degrees = 60 * (((g - b) / delta) % 6);
        else if (max === g) degrees = 60 * ((b - r) / delta + 2);
        else degrees = 60 * ((r - g) / delta + 4);
    }
    return {
        hue: Math.round((degrees + 360) % 360),
        saturation: max === 0 ? 0 : Math.round((delta / max) * 100)
    };
}

/** Hue and saturation as CIE xy, the colour space Hue bridges take, through
 *  sRGB with gamma removed and the Wide RGB D65 matrix Philips documents. */
export function hsToXy(hueDegrees: number, saturation: number): [number, number] {
    const linear = (channel: number) => {
        const c = channel / 255;
        return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
    };
    const [r, g, b] = hsToRgb(hueDegrees, saturation).map(linear) as [number, number, number];
    const x = r * 0.4124 + g * 0.3576 + b * 0.1805;
    const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const z = r * 0.0193 + g * 0.1192 + b * 0.9505;
    const sum = x + y + z;
    if (sum === 0) return [0.3127, 0.329];
    return [Math.round((x / sum) * 10_000) / 10_000, Math.round((y / sum) * 10_000) / 10_000];
}
