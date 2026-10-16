/**
 * When the sun rises, sets, and when civil twilight begins and ends, at a place
 * on a given day - computed here, with no service asked.
 *
 * The NOAA solar calculator's algorithm (the one behind its spreadsheet, after
 * Meeus' "Astronomical Algorithms"): the sun's declination and the equation of
 * time from the Julian century, then the hour angle at which the sun's centre
 * sits at a given depression below the horizon. Sunrise and sunset use
 * -0.833 degrees (refraction plus the sun's radius), civil dawn and dusk -6. It
 * is good to about a minute between the polar circles, which is what NOAA
 * itself claims for it.
 *
 * Everything is computed in UTC, so a daylight-saving change cannot move an
 * event. An event that does not happen that day - no sunset in a polar summer,
 * no sunrise in a polar winter - is `null`: it is skipped, never guessed at.
 *
 * Pure and client-safe.
 */

/** The moments of a day this computes. */
export const SUN_EVENTS = ["dawn", "sunrise", "sunset", "dusk"] as const;
export type SunEvent = (typeof SUN_EVENTS)[number];

/** A point on the Earth, in decimal degrees: north and east are positive. */
export interface Coordinate {
    readonly latitude: number;
    readonly longitude: number;
}

/** A calendar day, as the place reads it. */
export interface CalendarDay {
    readonly year: number;
    readonly month: number;
    readonly day: number;
}

/** How far below the horizon the sun's centre is at each event. */
const DEPRESSION: Readonly<Record<SunEvent, number>> = {
    dawn: 6,
    sunrise: 0.833,
    sunset: 0.833,
    dusk: 6
};

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
/** The Julian day of the Unix epoch. */
const EPOCH_JD = 2_440_587.5;

function julianCentury(at: number): number {
    return (at / DAY_MS + EPOCH_JD - 2_451_545) / 36_525;
}

/** The sun's declination (degrees) and the equation of time (minutes) at an
 *  instant. */
function sunAt(at: number): { declination: number; equationOfTime: number } {
    const t = julianCentury(at);
    const meanLong = (((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360) + 360) % 360;
    const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
    const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
    const m = meanAnomaly * RAD;
    const centre =
        Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
        Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
        Math.sin(3 * m) * 0.000289;
    const omega = (125.04 - 1934.136 * t) * RAD;
    const apparentLong = meanLong + centre - 0.00569 - 0.00478 * Math.sin(omega);
    const meanObliquity =
        23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
    const obliquity = (meanObliquity + 0.00256 * Math.cos(omega)) * RAD;
    const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparentLong * RAD)) / RAD;
    const y = Math.tan(obliquity / 2) ** 2;
    const l0 = meanLong * RAD;
    const equationOfTime =
        (4 *
            (y * Math.sin(2 * l0) -
                2 * eccentricity * Math.sin(m) +
                4 * eccentricity * y * Math.sin(m) * Math.cos(2 * l0) -
                0.5 * y * y * Math.sin(4 * l0) -
                1.25 * eccentricity * eccentricity * Math.sin(2 * m))) /
        RAD;
    return { declination, equationOfTime };
}

/** The hour angle (degrees) at which the sun's centre is `depression` below the
 *  horizon, or null when it never gets there that day. */
function hourAngle(latitude: number, declination: number, depression: number): number | null {
    const phi = latitude * RAD;
    const delta = declination * RAD;
    const cos =
        (Math.cos((90 + depression) * RAD) - Math.sin(phi) * Math.sin(delta)) /
        (Math.cos(phi) * Math.cos(delta));
    if (!Number.isFinite(cos) || cos < -1 || cos > 1) return null;
    return Math.acos(cos) / RAD;
}

/** Solar noon of a day at a longitude, as an instant: the UTC minute of the
 *  day the sun crosses the meridian there. */
export function solarNoon(day: CalendarDay, longitude: number): Date {
    const midnight = Date.UTC(day.year, day.month - 1, day.day);
    // Twice: the equation of time is read at the noon it is correcting.
    let noon = midnight + (720 - 4 * longitude) * 60_000;
    for (let pass = 0; pass < 2; pass += 1) {
        const { equationOfTime } = sunAt(noon);
        noon = midnight + (720 - 4 * longitude - equationOfTime) * 60_000;
    }
    return new Date(noon);
}

/**
 * When one event happens on a day at a place, or null when it does not happen
 * that day. The day is the place's own: its solar noon anchors it, so the
 * sunset of the 21st is the one on the evening of the 21st wherever it is.
 */
export function sunEventOn(event: SunEvent, day: CalendarDay, at: Coordinate): Date | null {
    if (!validCoordinate(at)) return null;
    const noon = solarNoon(day, at.longitude).getTime();
    const morning = event === "dawn" || event === "sunrise";
    let when = noon;
    // Read the sun again at the moment found, the way NOAA's own calculator
    // refines it: the declination moves enough in six hours to matter.
    for (let pass = 0; pass < 3; pass += 1) {
        const { declination, equationOfTime } = sunAt(when);
        const angle = hourAngle(at.latitude, declination, DEPRESSION[event]);
        if (angle === null) return null;
        const midnight = Date.UTC(day.year, day.month - 1, day.day);
        const centre = 720 - 4 * at.longitude - equationOfTime;
        when = midnight + (centre + (morning ? -4 : 4) * angle) * 60_000;
    }
    return new Date(when);
}

/** Every event of a day at a place, each null when it does not happen. */
export function sunTimes(day: CalendarDay, at: Coordinate): Record<SunEvent, Date | null> {
    return {
        dawn: sunEventOn("dawn", day, at),
        sunrise: sunEventOn("sunrise", day, at),
        sunset: sunEventOn("sunset", day, at),
        dusk: sunEventOn("dusk", day, at)
    };
}

/** How high the sun stands at an instant, in degrees above the horizon (no
 *  refraction). What the events are defined by, so it is what a test checks
 *  them against. */
export function solarElevation(instant: Date, at: Coordinate): number {
    const time = instant.getTime();
    const { declination, equationOfTime } = sunAt(time);
    const minutes = (((time % DAY_MS) + DAY_MS) % DAY_MS) / 60_000;
    const trueSolar = (((minutes + equationOfTime + 4 * at.longitude) % 1440) + 1440) % 1440;
    const hour = trueSolar / 4 - 180;
    const phi = at.latitude * RAD;
    const delta = declination * RAD;
    const cosZenith =
        Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(hour * RAD);
    return 90 - Math.acos(Math.min(1, Math.max(-1, cosZenith))) / RAD;
}

/** Whether a latitude and a longitude are a place on the Earth. */
export function validCoordinate(at: Coordinate): boolean {
    return (
        Number.isFinite(at.latitude) &&
        Number.isFinite(at.longitude) &&
        Math.abs(at.latitude) <= 90 &&
        Math.abs(at.longitude) <= 180
    );
}

/** A coordinate to two decimals, about a kilometre: close enough for the sun,
 *  which a kilometre moves by a few seconds, and too coarse to find a door by. */
export function roundCoordinate(at: Coordinate): Coordinate {
    const round = (value: number) => Math.round(value * 100) / 100 || 0;
    return { latitude: round(at.latitude), longitude: round(at.longitude) };
}
