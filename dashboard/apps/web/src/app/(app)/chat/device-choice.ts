/**
 * Whether a list of microphones, speakers or cameras is a choice worth showing.
 *
 * A device picker with one entry is a control that does nothing: a phone has
 * one microphone until a headset is plugged in, and a list that only ever
 * names it is clutter on the screen it is least welcome on. So a picker is
 * offered once there are two real devices - a headset arriving makes it
 * appear, its leaving makes it go.
 *
 * Chromium lists "default" and, on Windows, "communications" as entries of
 * their own that repeat a real device ("Default - Headset"), so they are not
 * counted. When those are all there is, the list is taken as it comes.
 *
 * Pure.
 */

/** The ids Chromium uses for its stand-ins for a real device. */
const STAND_INS = new Set(["default", "communications"]);

export function worthChoosing(devices: readonly { readonly id: string }[]): boolean {
    const real = devices.filter((device) => !STAND_INS.has(device.id));
    return (real.length > 0 ? real.length : devices.length) > 1;
}
