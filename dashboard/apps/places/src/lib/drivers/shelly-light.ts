/**
 * A Shelly light channel's brightness and colour, from Shelly's own API docs.
 *
 * Gen2+ (RPC): the `Light` component reports `brightness` (percent) in its
 * status and takes it in `Light.Set`. Gen1 (HTTP): a dimmer, a bulb and an
 * RGBW2 in white mode report `brightness` on `light/N` or `white/N` and take
 * `?brightness=`; an RGBW2 in colour mode reports `gain` and `red`/`green`/
 * `blue` on `color/0` and takes them the same way.
 */

import { hsToRgb, rgbToHs, type LightCommand, type LightSettings } from "../light-kinds";

function level(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.min(100, Math.max(0, Math.round(value)))
        : null;
}

/** What a channel is set to, or null when it reports no brightness (a relay). */
export function shellyLightSettings(
    status: Record<string, unknown>,
    field: "brightness" | "gain",
    lit: boolean,
    colorful: boolean
): LightSettings | null {
    const brightness = level(status[field]);
    if (brightness === null) return null;
    const rgb = [status.red, status.green, status.blue];
    const color =
        colorful && lit && rgb.every((channel) => typeof channel === "number")
            ? rgbToHs(rgb[0] as number, rgb[1] as number, rgb[2] as number)
            : null;
    return {
        brightness: { level: lit ? brightness : null },
        temperature: null,
        color: colorful ? { hue: color?.hue ?? null, saturation: color?.saturation ?? null } : null
    };
}

/** The call a command is on a channel: RPC params on Gen2+, a path on Gen1.
 *  Setting a channel switches it on. Null for what the channel cannot take. */
export function shellyLightCall(
    channel: string,
    command: LightCommand
): { rpc: Record<string, unknown>; path?: never } | { path: string; rpc?: never } | null {
    const rpc = /^light:(\d+)$/.exec(channel);
    if (rpc) {
        return command.action === "set-brightness"
            ? { rpc: { id: Number(rpc[1]), on: true, brightness: Math.round(command.level) } }
            : null;
    }
    const gen1 = /^(light|white|color)\/(\d+)$/.exec(channel);
    if (!gen1) return null;
    const base = `/${gen1[1]}/${gen1[2]}`;
    if (command.action === "set-brightness") {
        const field = gen1[1] === "color" ? "gain" : "brightness";
        return { path: `${base}?turn=on&${field}=${Math.round(command.level)}` };
    }
    if (command.action === "set-color" && gen1[1] === "color") {
        const [red, green, blue] = hsToRgb(command.hue, command.saturation);
        return { path: `${base}?turn=on&red=${red}&green=${green}&blue=${blue}` };
    }
    return null;
}
