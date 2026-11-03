/**
 * The units Polar can check a conversion against: exact factors to one base
 * unit per dimension, plus the three temperature scales. A unit that is not
 * here (or is ambiguous, like a bare "gallon" or "cup") is simply not checked.
 *
 * Pure; shared by the server (checking a view) and the browser.
 */

type Dimension = "length" | "mass" | "volume" | "area" | "speed" | "time";

/** Factors to the dimension's base unit: m, kg, l, m2, m/s, s. */
const FACTORS: Record<string, [Dimension, number]> = {
    mm: ["length", 0.001],
    cm: ["length", 0.01],
    m: ["length", 1],
    km: ["length", 1000],
    in: ["length", 0.0254],
    ft: ["length", 0.3048],
    yd: ["length", 0.9144],
    mi: ["length", 1609.344],
    nmi: ["length", 1852],
    mg: ["mass", 1e-6],
    g: ["mass", 0.001],
    kg: ["mass", 1],
    t: ["mass", 1000],
    oz: ["mass", 0.028349523125],
    lb: ["mass", 0.45359237],
    st: ["mass", 6.35029318],
    ml: ["volume", 0.001],
    cl: ["volume", 0.01],
    dl: ["volume", 0.1],
    l: ["volume", 1],
    m3: ["volume", 1000],
    "us gal": ["volume", 3.785411784],
    "uk gal": ["volume", 4.54609],
    "us fl oz": ["volume", 0.0295735295625],
    "uk fl oz": ["volume", 0.0284130625],
    mm2: ["area", 1e-6],
    cm2: ["area", 1e-4],
    m2: ["area", 1],
    km2: ["area", 1e6],
    ha: ["area", 1e4],
    acre: ["area", 4046.8564224],
    in2: ["area", 0.00064516],
    ft2: ["area", 0.09290304],
    yd2: ["area", 0.83612736],
    mi2: ["area", 2589988.110336],
    "m/s": ["speed", 1],
    "km/h": ["speed", 1 / 3.6],
    mph: ["speed", 0.44704],
    kn: ["speed", 1852 / 3600],
    "ft/s": ["speed", 0.3048],
    ms: ["time", 0.001],
    s: ["time", 1],
    min: ["time", 60],
    h: ["time", 3600],
    d: ["time", 86400],
    wk: ["time", 604800]
};

const ALIASES: Record<string, string> = {
    kph: "km/h",
    kmh: "km/h",
    knot: "kn",
    knots: "kn",
    kt: "kn",
    lbs: "lb",
    acres: "acre",
    sq_m: "m2",
    sec: "s",
    hr: "h"
};

type Scale = "c" | "f" | "k";
const SCALES: Record<string, Scale> = {
    c: "c",
    celsius: "c",
    f: "f",
    fahrenheit: "f",
    k: "k",
    kelvin: "k"
};

/** One spelling of a unit: lower case, superscripts as digits, no degree sign. */
function normalize(unit: string): string {
    return unit
        .trim()
        .toLowerCase()
        .replace(/²/g, "2")
        .replace(/³/g, "3")
        .replace(/[°º]/g, "")
        .replace(/\s+/g, " ");
}

function toKelvin(value: number, scale: Scale): number {
    if (scale === "c") return value + 273.15;
    if (scale === "f") return ((value - 32) * 5) / 9 + 273.15;
    return value;
}

function fromKelvin(value: number, scale: Scale): number {
    if (scale === "c") return value - 273.15;
    if (scale === "f") return ((value - 273.15) * 9) / 5 + 32;
    return value;
}

/** `value` in `from` expressed in `to`, or null when either unit is unknown
 *  here or the two measure different things. */
export function convertUnit(value: number, from: string, to: string): number | null {
    const a = normalize(from);
    const b = normalize(to);
    const scaleA = SCALES[a];
    const scaleB = SCALES[b];
    if (scaleA && scaleB) return fromKelvin(toKelvin(value, scaleA), scaleB);
    const left = FACTORS[ALIASES[a] ?? a];
    const right = FACTORS[ALIASES[b] ?? b];
    if (!left || !right || left[0] !== right[0]) return null;
    return (value * left[1]) / right[1];
}

/** Whether `actual` is `expected` within a hundredth of it (rounding the model
 *  did to show the figure is fine; a wrong factor is not). */
export function closeTo(actual: number, expected: number): boolean {
    return Math.abs(actual - expected) <= Math.max(1e-9, Math.abs(expected) * 0.01);
}
