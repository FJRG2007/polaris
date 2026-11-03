/**
 * The views Polar can draw inside an answer: a table, a chart, a row of
 * figures, steps, a side-by-side comparison, a small diagram and a calculator,
 * and the answer cards - a translation, the weather, the time in other places
 * and a conversion - that a question of that shape is answered with.
 *
 * The model never writes markup or code. It calls one tool (`polar_show`) with
 * data shaped by one of these schemas, and the chat draws it with Polaris's own
 * components - the trusted-catalog approach of Google's A2UI
 * (https://github.com/google/A2UI), carried by a typed tool call the way the AI
 * SDK's generative UI renders tool parts
 * (https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces). Third-party
 * views in a sandboxed frame (MCP Apps, SEP-1865) are a separate, later path.
 *
 * Every view also reads as Markdown (`visualMarkdown`): what is copied, what an
 * export and a shared chat keep, and what the chat shows when a view fails to
 * draw. A stored view that no longer passes these schemas is left out.
 *
 * Shared by the server (tool input) and the browser (drawing a stored part).
 */

import { z } from "zod";
import { closeTo, convertUnit } from "@/lib/polar/units";
import { instantOf, isTimeZone, isWallTime, zoneOffsetMinutes } from "@/lib/polar/zones";

/** The tool's name, as its parts are typed: `tool-polar_show`. */
export const POLAR_VISUAL_TOOL = "polar_show";

const TEXT_MAX = 300;
const label = z.string().min(1).max(120);
const text = z.string().max(TEXT_MAX);
const cell = z.union([text, z.number().finite(), z.null()]);

const tableView = z.object({
    kind: z.literal("table"),
    columns: z
        .array(z.object({ label, align: z.enum(["start", "end"]).optional() }))
        .min(1)
        .max(12),
    rows: z.array(z.array(cell).max(12)).min(1).max(200)
});

const chartView = z.object({
    kind: z.literal("chart"),
    type: z.enum(["bar", "line"]),
    /** The x axis: names for a bar chart, or dates (YYYY-MM-DD) for a line over time. */
    categories: z.array(z.string().min(1).max(60)).min(1).max(60),
    series: z
        .array(
            z.object({
                label,
                values: z.array(z.number().finite().nullable()).min(1).max(60)
            })
        )
        .min(1)
        .max(4),
    unit: z.string().max(16).optional()
});

const statsView = z.object({
    kind: z.literal("stats"),
    items: z
        .array(
            z.object({
                label,
                value: z.string().min(1).max(40),
                detail: z.string().max(120).optional(),
                tone: z.enum(["neutral", "good", "warning", "bad"]).optional()
            })
        )
        .min(1)
        .max(8)
});

const stepsView = z.object({
    kind: z.literal("steps"),
    items: z
        .array(z.object({ title: label, detail: text.optional() }))
        .min(1)
        .max(20)
});

const comparisonView = z.object({
    kind: z.literal("comparison"),
    options: z.array(label).min(2).max(5),
    rows: z
        .array(z.object({ label, values: z.array(text).min(2).max(5) }))
        .min(1)
        .max(30),
    /** The option the answer recommends, by its position in `options`. */
    pick: z.number().int().min(0).max(4).optional()
});

const nodeId = z
    .string()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/);
const diagramView = z.object({
    kind: z.literal("diagram"),
    direction: z.enum(["down", "right"]).optional(),
    nodes: z
        .array(z.object({ id: nodeId, label: z.string().min(1).max(60) }))
        .min(1)
        .max(24),
    edges: z
        .array(z.object({ from: nodeId, to: nodeId, label: z.string().max(30).optional() }))
        .max(40)
});

const fieldId = z
    .string()
    .min(1)
    .max(24)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const calculatorView = z.object({
    kind: z.literal("calculator"),
    fields: z
        .array(
            z.object({
                id: fieldId,
                label,
                value: z.number().finite(),
                min: z.number().finite().optional(),
                max: z.number().finite().optional(),
                step: z.number().finite().positive().optional(),
                unit: z.string().max(16).optional()
            })
        )
        .min(1)
        .max(8),
    outputs: z
        .array(
            z.object({
                label,
                /** Arithmetic over the field ids, read by `parseFormula`. */
                formula: z.string().min(1).max(200),
                unit: z.string().max(16).optional(),
                decimals: z.number().int().min(0).max(6).optional()
            })
        )
        .min(1)
        .max(6)
});

/** A BCP 47 language tag, such as `en`, `es-MX` or `zh-Hant`; checked for real
 *  by `Intl.getCanonicalLocales` in `viewProblem`. */
const languageTag = z
    .string()
    .min(2)
    .max(35)
    .regex(/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/);
const translationView = z.object({
    kind: z.literal("translation"),
    /** The source language, or "detected" (or left out) when it was guessed. */
    from: languageTag.optional(),
    to: languageTag,
    source: z.string().min(1).max(2000),
    translation: z.string().min(1).max(2000),
    alternatives: z.array(z.string().min(1).max(500)).max(3).optional(),
    /** Formality, register, a word with no exact match. */
    notes: z.string().max(TEXT_MAX).optional()
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A local time as Open-Meteo gives it: `YYYY-MM-DDTHH:mm`, no offset. */
const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const weatherCode = z.number().int().min(0).max(99);
const temperature = z.number().finite().min(-150).max(150);
const percent = z.number().finite().min(0).max(100);
const weatherView = z.object({
    kind: z.literal("weather"),
    place: z.string().min(1).max(120),
    asOf: localTime.optional(),
    units: z.enum(["metric", "imperial"]),
    current: z
        .object({
            temperature,
            apparent: temperature.optional(),
            /** A WMO weather interpretation code (`WEATHER_CODES`). */
            code: weatherCode,
            wind: z.number().finite().min(0).max(1000).optional(),
            humidity: percent.optional()
        })
        .optional(),
    days: z
        .array(
            z.object({
                date: isoDate,
                min: temperature,
                max: temperature,
                code: weatherCode,
                precipitation: percent.optional()
            })
        )
        .max(7)
        .optional()
});

const timeView = z.object({
    kind: z.literal("time"),
    /** A wall time (`YYYY-MM-DDTHH:mm`) in the first place's zone, to convert;
     *  left out, the card shows the time now. */
    at: localTime.optional(),
    places: z
        .array(z.object({ label: z.string().min(1).max(80), zone: z.string().min(1).max(64) }))
        .min(1)
        .max(6)
});

const amount = z.object({
    value: z.number().finite(),
    /** A unit symbol (km, °F, lb), or an ISO 4217 code for a currency. */
    unit: z.string().min(1).max(24)
});
const conversionView = z.object({
    kind: z.literal("conversion"),
    type: z.enum(["unit", "currency"]),
    from: amount,
    to: amount,
    /** One line of how: `°F = °C × 9/5 + 32`. */
    formula: z.string().max(160).optional(),
    /** For a currency: one unit of `from` in `to`. */
    rate: z.number().finite().positive().optional(),
    /** For a currency, required: where the rate came from and its date. */
    source: z.string().min(1).max(120).optional(),
    asOf: isoDate.optional()
});

const viewSchema = z.discriminatedUnion("kind", [
    tableView,
    chartView,
    statsView,
    stepsView,
    comparisonView,
    diagramView,
    calculatorView,
    translationView,
    weatherView,
    timeView,
    conversionView
]);

/**
 * The tool's input. An object at the top with the union inside it: several
 * providers take only an object as a tool's parameters.
 */
export const polarVisualSchema = z
    .object({
        title: z.string().max(120).optional(),
        view: viewSchema
    })
    .superRefine((value, context) => {
        const problem = viewProblem(value.view);
        if (problem)
            context.addIssue({ code: z.ZodIssueCode.custom, path: ["view"], message: problem });
    });

export type PolarVisual = z.infer<typeof polarVisualSchema>;
export type PolarView = PolarVisual["view"];
export type CalculatorView = z.infer<typeof calculatorView>;
export type ChartView = z.infer<typeof chartView>;
export type DiagramView = z.infer<typeof diagramView>;
export type TranslationView = z.infer<typeof translationView>;
export type WeatherView = z.infer<typeof weatherView>;
export type TimeView = z.infer<typeof timeView>;
export type ConversionView = z.infer<typeof conversionView>;

/** Icon groups a weather card draws a condition with. */
export type WeatherGroup =
    "clear" | "partly" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "storm";

/**
 * The WMO weather interpretation codes Open-Meteo reports
 * (https://open-meteo.com/en/docs, "WMO Weather interpretation codes"): the
 * catalogue key of each one's label, its icon group, and its English text for
 * the Markdown form.
 */
export const WEATHER_CODES = {
    0: { key: "clear", group: "clear", text: "Clear sky" },
    1: { key: "mainlyClear", group: "partly", text: "Mainly clear" },
    2: { key: "partlyCloudy", group: "partly", text: "Partly cloudy" },
    3: { key: "overcast", group: "cloudy", text: "Overcast" },
    45: { key: "fog", group: "fog", text: "Fog" },
    48: { key: "rimeFog", group: "fog", text: "Depositing rime fog" },
    51: { key: "drizzleLight", group: "drizzle", text: "Light drizzle" },
    53: { key: "drizzleModerate", group: "drizzle", text: "Moderate drizzle" },
    55: { key: "drizzleDense", group: "drizzle", text: "Dense drizzle" },
    56: { key: "freezingDrizzleLight", group: "drizzle", text: "Light freezing drizzle" },
    57: { key: "freezingDrizzleDense", group: "drizzle", text: "Dense freezing drizzle" },
    61: { key: "rainSlight", group: "rain", text: "Slight rain" },
    63: { key: "rainModerate", group: "rain", text: "Moderate rain" },
    65: { key: "rainHeavy", group: "rain", text: "Heavy rain" },
    66: { key: "freezingRainLight", group: "rain", text: "Light freezing rain" },
    67: { key: "freezingRainHeavy", group: "rain", text: "Heavy freezing rain" },
    71: { key: "snowSlight", group: "snow", text: "Slight snowfall" },
    73: { key: "snowModerate", group: "snow", text: "Moderate snowfall" },
    75: { key: "snowHeavy", group: "snow", text: "Heavy snowfall" },
    77: { key: "snowGrains", group: "snow", text: "Snow grains" },
    80: { key: "showersSlight", group: "rain", text: "Slight rain showers" },
    81: { key: "showersModerate", group: "rain", text: "Moderate rain showers" },
    82: { key: "showersViolent", group: "rain", text: "Violent rain showers" },
    85: { key: "snowShowersSlight", group: "snow", text: "Slight snow showers" },
    86: { key: "snowShowersHeavy", group: "snow", text: "Heavy snow showers" },
    95: { key: "thunderstorm", group: "storm", text: "Thunderstorm" },
    96: { key: "thunderstormHailSlight", group: "storm", text: "Thunderstorm with slight hail" },
    97: { key: "thunderstormHeavy", group: "storm", text: "Heavy thunderstorm" },
    99: { key: "thunderstormHailHeavy", group: "storm", text: "Thunderstorm with heavy hail" }
} as const satisfies Record<number, { key: string; group: WeatherGroup; text: string }>;
export type WeatherCode = keyof typeof WEATHER_CODES;

/** A code's entry, or null when it is not a WMO code this knows. */
export function weatherCodeOf(code: number): (typeof WEATHER_CODES)[WeatherCode] | null {
    return (WEATHER_CODES as Record<number, (typeof WEATHER_CODES)[WeatherCode]>)[code] ?? null;
}

/** "detected", an empty or left-out source language: it was guessed. */
export function sourceLanguageOf(view: TranslationView): string | null {
    return view.from && view.from.toLowerCase() !== "detected" ? view.from : null;
}

/** A language tag's name in `locale`, or the tag itself when it has none. */
export function languageName(tag: string, locale?: string): string {
    try {
        return new Intl.DisplayNames(locale, { type: "language" }).of(tag) ?? tag;
    } catch {
        return tag;
    }
}

function realLanguageTag(tag: string): boolean {
    try {
        return Intl.getCanonicalLocales(tag).length === 1;
    } catch {
        return false;
    }
}

function realDate(date: string): boolean {
    return isWallTime(`${date}T00:00`);
}

/** What no schema can say on its own: rows that match their columns, edges that
 *  name real nodes, formulas that read. Null when the view is whole. */
function viewProblem(view: PolarView): string | null {
    switch (view.kind) {
        case "table":
            return view.rows.some((row) => row.length > view.columns.length)
                ? "A row has more cells than there are columns."
                : null;
        case "chart":
            return view.series.some((line) => line.values.length !== view.categories.length)
                ? "Every series needs one value per category."
                : null;
        case "comparison":
            if (view.rows.some((row) => row.values.length !== view.options.length)) {
                return "Every row needs one value per option.";
            }
            return view.pick !== undefined && view.pick >= view.options.length
                ? "pick names an option that is not there."
                : null;
        case "diagram": {
            const ids = new Set(view.nodes.map((node) => node.id));
            if (ids.size !== view.nodes.length) return "Two nodes share an id.";
            return view.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))
                ? "An edge names a node that is not there."
                : null;
        }
        case "calculator": {
            const ids = new Set(view.fields.map((field) => field.id));
            if (ids.size !== view.fields.length) return "Two fields share an id.";
            for (const field of view.fields) {
                if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
                    return `${field.label}: min is above max.`;
                }
                const below = field.min !== undefined && field.value < field.min;
                const above = field.max !== undefined && field.value > field.max;
                if (below || above) {
                    return `${field.label}: its value is outside min and max.`;
                }
            }
            for (const output of view.outputs) {
                const parsed = parseFormula(output.formula);
                if (typeof parsed === "string") return `${output.label}: ${parsed}`;
                const unknown = namesIn(parsed).find((name) => !ids.has(name));
                if (unknown) return `${output.label}: ${unknown} is not a field.`;
            }
            return null;
        }
        case "translation": {
            const from = sourceLanguageOf(view);
            if (from && !realLanguageTag(from)) return `${from} is not a language tag.`;
            return realLanguageTag(view.to) ? null : `${view.to} is not a language tag.`;
        }
        case "weather": {
            if (!view.current && !view.days?.length) return "It needs current conditions or days.";
            if (view.asOf && !isWallTime(view.asOf)) return "asOf is not a real time.";
            const codes = [
                ...(view.current ? [view.current.code] : []),
                ...(view.days ?? []).map((day) => day.code)
            ];
            const unknown = codes.find((code) => !weatherCodeOf(code));
            if (unknown !== undefined) return `${unknown} is not a WMO weather code.`;
            for (const day of view.days ?? []) {
                if (!realDate(day.date)) return `${day.date} is not a real date.`;
                if (day.min > day.max) return `${day.date}: min is above max.`;
            }
            return null;
        }
        case "time": {
            const wrong = view.places.find((place) => !isTimeZone(place.zone));
            if (wrong) return `${wrong.zone} is not an IANA time zone.`;
            return view.at && !isWallTime(view.at) ? "at is not a real time." : null;
        }
        case "conversion": {
            if (view.type === "currency") {
                const code = /^[A-Z]{3}$/;
                if (!code.test(view.from.unit) || !code.test(view.to.unit))
                    return "A currency is its ISO 4217 code, such as EUR.";
                if (!view.source || !view.asOf) return "A currency rate needs source and asOf.";
                if (!realDate(view.asOf)) return "asOf is not a real date.";
                if (view.rate !== undefined && !closeTo(view.to.value, view.from.value * view.rate))
                    return "to.value is not from.value times rate.";
                return null;
            }
            const expected = convertUnit(view.from.value, view.from.unit, view.to.unit);
            return expected !== null && !closeTo(view.to.value, expected)
                ? `to.value is wrong: ${view.from.value} ${view.from.unit} is ${Number(expected.toPrecision(8))} ${view.to.unit}.`
                : null;
        }
        default:
            return null;
    }
}

/** A stored part's view, or null when it is not one, is unfinished, or no
 *  longer passes the schema (the chat then leaves it out). */
export function visualOf(input: unknown): PolarVisual | null {
    const parsed = polarVisualSchema.safeParse(input);
    return parsed.success ? parsed.data : null;
}

/** Whether a message part is one of these views, whatever state it is in. */
export function isVisualPart(part: { type?: unknown } | null | undefined): boolean {
    return part?.type === `tool-${POLAR_VISUAL_TOOL}`;
}

// ---------------------------------------------------------------------------
// Formulas
// ---------------------------------------------------------------------------

export type Formula =
    | { op: "num"; value: number }
    | { op: "var"; name: string }
    | { op: "neg"; arg: Formula }
    | { op: "+" | "-" | "*" | "/" | "%" | "^"; left: Formula; right: Formula }
    | { op: "call"; name: FunctionName; args: Formula[] };

const FUNCTIONS = {
    min: (...args: number[]) => Math.min(...args),
    max: (...args: number[]) => Math.max(...args),
    round: (value: number) => Math.round(value),
    floor: (value: number) => Math.floor(value),
    ceil: (value: number) => Math.ceil(value),
    abs: (value: number) => Math.abs(value),
    sqrt: (value: number) => Math.sqrt(value),
    log: (value: number) => Math.log(value),
    exp: (value: number) => Math.exp(value),
    pow: (base: number, power: number) => base ** power
} as const;
type FunctionName = keyof typeof FUNCTIONS;
const ARITY: Record<FunctionName, [number, number]> = {
    min: [1, 8],
    max: [1, 8],
    round: [1, 1],
    floor: [1, 1],
    ceil: [1, 1],
    abs: [1, 1],
    sqrt: [1, 1],
    log: [1, 1],
    exp: [1, 1],
    pow: [2, 2]
};

/** A calculator formula parsed into a tree, or why it does not read. Nothing
 *  the model wrote is ever run as code: this tree is all that is evaluated. */
export function parseFormula(source: string): Formula | string {
    const tokens =
        source.match(/\d+(?:\.\d+)?(?:e[+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/%^(),]|\S/gi) ?? [];
    let at = 0;
    const peek = (): string | undefined => tokens[at];
    const fail = (why: string): never => {
        throw new FormulaError(why);
    };
    const expect = (token: string): void => {
        if (tokens[at] !== token) fail(`expected "${token}"`);
        at++;
    };
    const sum = (): Formula => {
        let left = product();
        while (peek() === "+" || peek() === "-") {
            const op = tokens[at++] as "+" | "-";
            left = { op, left, right: product() };
        }
        return left;
    };
    const product = (): Formula => {
        let left = unary();
        while (peek() === "*" || peek() === "/" || peek() === "%") {
            const op = tokens[at++] as "*" | "/" | "%";
            left = { op, left, right: unary() };
        }
        return left;
    };
    const unary = (): Formula => {
        if (peek() === "-") {
            at++;
            return { op: "neg", arg: unary() };
        }
        if (peek() === "+") {
            at++;
            return unary();
        }
        return power();
    };
    const power = (): Formula => {
        const base = primary();
        if (peek() !== "^") return base;
        at++;
        return { op: "^", left: base, right: unary() };
    };
    const primary = (): Formula => {
        const token = tokens[at++];
        if (token === undefined) return fail("it ends too soon");
        if (token === "(") {
            const inner = sum();
            expect(")");
            return inner;
        }
        if (/^\d/.test(token)) return { op: "num", value: Number(token) };
        if (/^[A-Za-z_]/.test(token)) {
            if (peek() !== "(") return { op: "var", name: token };
            const name = token.toLowerCase();
            if (!(name in FUNCTIONS)) return fail(`${token} is not a function it knows`);
            at++;
            const args: Formula[] = [];
            if (peek() !== ")") {
                args.push(sum());
                while (peek() === ",") {
                    at++;
                    args.push(sum());
                }
            }
            expect(")");
            const [least, most] = ARITY[name as FunctionName];
            if (args.length < least || args.length > most)
                fail(`${token} takes a different number of values`);
            return { op: "call", name: name as FunctionName, args };
        }
        return fail(`"${token}" is not allowed`);
    };
    try {
        if (tokens.length === 0) return "it is empty";
        const tree = sum();
        if (at < tokens.length) return `"${tokens[at]}" is not expected there`;
        return tree;
    } catch (error) {
        if (error instanceof FormulaError) return error.message;
        throw error;
    }
}

class FormulaError extends Error {}

function namesIn(tree: Formula): string[] {
    switch (tree.op) {
        case "num":
            return [];
        case "var":
            return [tree.name];
        case "neg":
            return namesIn(tree.arg);
        case "call":
            return tree.args.flatMap(namesIn);
        default:
            return [...namesIn(tree.left), ...namesIn(tree.right)];
    }
}

/** A parsed formula's value for these inputs; NaN when it has none (a division
 *  by zero, the root of a negative number). */
export function evaluateFormula(tree: Formula, values: Readonly<Record<string, number>>): number {
    switch (tree.op) {
        case "num":
            return tree.value;
        case "var":
            return values[tree.name] ?? Number.NaN;
        case "neg":
            return -evaluateFormula(tree.arg, values);
        case "call":
            return (FUNCTIONS[tree.name] as (...args: number[]) => number)(
                ...tree.args.map((arg) => evaluateFormula(arg, values))
            );
        default: {
            const left = evaluateFormula(tree.left, values);
            const right = evaluateFormula(tree.right, values);
            if (tree.op === "+") return left + right;
            if (tree.op === "-") return left - right;
            if (tree.op === "*") return left * right;
            if (tree.op === "/") return right === 0 ? Number.NaN : left / right;
            if (tree.op === "%") return right === 0 ? Number.NaN : left % right;
            return left ** right;
        }
    }
}

/** One output's value for these inputs, or null when it has none. */
export function calculate(
    formula: string,
    values: Readonly<Record<string, number>>
): number | null {
    const tree = parseFormula(formula);
    if (typeof tree === "string") return null;
    const value = evaluateFormula(tree, values);
    return Number.isFinite(value) ? value : null;
}

/** The fields' starting values, by id. */
export function startingValues(view: CalculatorView): Record<string, number> {
    return Object.fromEntries(view.fields.map((field) => [field.id, field.value]));
}

/** A number as a calculator shows it. */
export function formatResult(value: number | null, decimals = 2, locale?: string): string {
    if (value === null) return "-";
    return new Intl.NumberFormat(locale, { maximumFractionDigits: decimals }).format(value);
}

// ---------------------------------------------------------------------------
// As text
// ---------------------------------------------------------------------------

function inline(value: string | number | null | undefined): string {
    if (value === null || value === undefined) return "";
    return String(value).replace(/\s+/g, " ").trim();
}

function markdownCell(value: string | number | null | undefined): string {
    return inline(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function markdownTable(
    header: readonly string[],
    rows: readonly (readonly (string | number | null)[])[]
): string {
    const line = (cells: readonly (string | number | null)[]) =>
        `| ${header.map((_, index) => markdownCell(cells[index])).join(" | ")} |`;
    return [line(header), `| ${header.map(() => "---").join(" | ")} |`, ...rows.map(line)].join(
        "\n"
    );
}

/** A view's rows as a grid of cells: what its CSV and Markdown table hold.
 *  Null for a view that is not tabular. */
export function visualGrid(
    view: PolarView
): { header: string[]; rows: (string | number | null)[][] } | null {
    switch (view.kind) {
        case "table":
            return { header: view.columns.map((column) => column.label), rows: view.rows };
        case "chart":
            return {
                header: [
                    "",
                    ...view.series.map((line) =>
                        view.unit ? `${line.label} (${view.unit})` : line.label
                    )
                ],
                rows: view.categories.map((category, index) => [
                    category,
                    ...view.series.map((line) => line.values[index] ?? null)
                ])
            };
        case "comparison":
            return {
                header: ["", ...view.options],
                rows: view.rows.map((row) => [row.label, ...row.values])
            };
        default:
            return null;
    }
}

/** A view as Markdown: copied, exported and shared in its place. */
export function visualMarkdown(visual: PolarVisual): string {
    const { view } = visual;
    const title = visual.title?.trim() ? `**${inline(visual.title)}**\n\n` : "";
    const grid = visualGrid(view);
    if (grid) return title + markdownTable(grid.header, grid.rows);
    switch (view.kind) {
        case "stats":
            return (
                title +
                view.items
                    .map(
                        (item) =>
                            `- **${inline(item.label)}**: ${inline(item.value)}${item.detail ? ` (${inline(item.detail)})` : ""}`
                    )
                    .join("\n")
            );
        case "steps":
            return (
                title +
                view.items
                    .map(
                        (item, index) =>
                            `${index + 1}. **${inline(item.title)}**${item.detail ? ` - ${inline(item.detail)}` : ""}`
                    )
                    .join("\n")
            );
        case "diagram": {
            const names = new Map(view.nodes.map((node) => [node.id, inline(node.label)]));
            const linked = new Set(view.edges.flatMap((edge) => [edge.from, edge.to]));
            const lines = view.edges.map(
                (edge) =>
                    `- ${names.get(edge.from)} -> ${names.get(edge.to)}${edge.label ? ` (${inline(edge.label)})` : ""}`
            );
            for (const node of view.nodes)
                if (!linked.has(node.id)) lines.push(`- ${names.get(node.id)}`);
            return title + lines.join("\n");
        }
        case "calculator": {
            const values = startingValues(view);
            const fields = view.fields.map(
                (field) =>
                    `- ${inline(field.label)}: ${field.value}${field.unit ? ` ${inline(field.unit)}` : ""}`
            );
            const outputs = view.outputs.map((output) => {
                const value = formatResult(
                    calculate(output.formula, values),
                    output.decimals ?? 2,
                    "en-US"
                );
                return `- **${inline(output.label)}** = ${inline(output.formula)} = ${value}${output.unit ? ` ${inline(output.unit)}` : ""}`;
            });
            return title + [...fields, ...outputs].join("\n");
        }
        case "translation":
            return title + translationMarkdown(view);
        case "weather":
            return title + weatherMarkdown(view);
        case "time":
            return title + timeMarkdown(view, Date.now());
        case "conversion":
            return title + conversionMarkdown(view);
        default:
            return title;
    }
}

function quoted(value: string): string {
    return value
        .trim()
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join("\n");
}

function translationMarkdown(view: TranslationView): string {
    const from = sourceLanguageOf(view);
    const lines = [
        `${from ? languageName(from, "en-US") : "Detected language"} -> ${languageName(view.to, "en-US")}`,
        "",
        quoted(view.source),
        "",
        view.translation.trim()
    ];
    if (view.alternatives?.length)
        lines.push("", `- Alternatives: ${view.alternatives.map(inline).join("; ")}`);
    if (view.notes?.trim()) lines.push("", `- Note: ${inline(view.notes)}`);
    return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** The symbols a weather view's figures carry. */
export function weatherUnits(units: WeatherView["units"]): { temperature: string; wind: string } {
    return units === "imperial"
        ? { temperature: "°F", wind: "mph" }
        : { temperature: "°C", wind: "km/h" };
}

function weatherMarkdown(view: WeatherView): string {
    const unit = weatherUnits(view.units);
    const degrees = (value: number) => `${Math.round(value)} ${unit.temperature}`;
    const lines = [
        `**${inline(view.place)}**${view.asOf ? ` (as of ${view.asOf.replace("T", " ")})` : ""}`
    ];
    if (view.current) {
        const now = view.current;
        const details = [
            now.apparent !== undefined ? `feels like ${degrees(now.apparent)}` : null,
            now.wind !== undefined ? `wind ${Math.round(now.wind)} ${unit.wind}` : null,
            now.humidity !== undefined ? `humidity ${Math.round(now.humidity)}%` : null
        ].filter(Boolean);
        lines.push(
            "",
            `- Now: ${degrees(now.temperature)}, ${weatherCodeOf(now.code)?.text ?? now.code}${details.length ? ` (${details.join(", ")})` : ""}`
        );
    }
    if (view.days?.length) {
        lines.push(
            "",
            markdownTable(
                ["Date", "Conditions", "Min", "Max", "Rain"],
                view.days.map((day) => [
                    day.date,
                    weatherCodeOf(day.code)?.text ?? String(day.code),
                    degrees(day.min),
                    degrees(day.max),
                    day.precipitation !== undefined ? `${Math.round(day.precipitation)}%` : ""
                ])
            )
        );
    }
    return lines.join("\n");
}

/** The instant a time view shows: its `at` in the first place's zone, or now. */
export function timeInstant(view: TimeView, now: number): number {
    const first = view.places[0];
    return (view.at && first ? instantOf(view.at, first.zone) : null) ?? now;
}

/** Minutes each place is ahead of the first one at `instant`. */
export function timeOffsets(view: TimeView, instant: number): number[] {
    const base = zoneOffsetMinutes(instant, view.places[0]?.zone ?? "UTC");
    return view.places.map((place) => zoneOffsetMinutes(instant, place.zone) - base);
}

/** An offset in minutes as `+5 h 30 min`, `-1 h` or `0 h`. */
export function offsetText(minutes: number): string {
    const sign = minutes > 0 ? "+" : minutes < 0 ? "-" : "";
    const hours = Math.floor(Math.abs(minutes) / 60);
    const rest = Math.abs(minutes) % 60;
    return `${sign}${hours} h${rest ? ` ${rest} min` : ""}`;
}

function timeMarkdown(view: TimeView, now: number): string {
    const instant = timeInstant(view, now);
    const offsets = timeOffsets(view, instant);
    return view.places
        .map((place, index) => {
            const when = new Intl.DateTimeFormat("en-US", {
                timeZone: place.zone,
                dateStyle: "medium",
                timeStyle: "short"
            }).format(instant);
            const offset = index === 0 ? "" : ` (${offsetText(offsets[index] ?? 0)})`;
            return `- **${inline(place.label)}** (${place.zone}): ${when}${offset}`;
        })
        .join("\n");
}

/** A converted amount as text: a currency in its own format, a unit after its
 *  figure. */
export function amountText(
    amount: ConversionView["from"],
    type: ConversionView["type"],
    locale?: string
): string {
    if (type === "currency") {
        try {
            return new Intl.NumberFormat(locale, {
                style: "currency",
                currency: amount.unit,
                maximumFractionDigits: 4
            }).format(amount.value);
        } catch {
            // An unknown code still reads as a figure and a code.
        }
    }
    const figure = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(amount.value);
    return `${figure} ${amount.unit}`;
}

/** A currency view's rate as one line: `1 EUR = 1.08 USD`. */
export function rateText(view: ConversionView, locale?: string): string | null {
    if (view.type !== "currency" || view.rate === undefined) return null;
    const rate = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(view.rate);
    return `1 ${view.from.unit} = ${rate} ${view.to.unit}`;
}

function conversionMarkdown(view: ConversionView): string {
    const lines = [
        `**${amountText(view.from, view.type, "en-US")} = ${amountText(view.to, view.type, "en-US")}**`
    ];
    const how = rateText(view, "en-US") ?? view.formula?.trim();
    if (how) lines.push("", inline(how));
    if (view.type === "currency" && view.source)
        lines.push("", `Source: ${inline(view.source)}${view.asOf ? `, ${view.asOf}` : ""}`);
    return lines.join("\n");
}

/** A tabular view as CSV, quoted the way RFC 4180 reads it. Null when the view
 *  is not tabular. A cell that starts like a formula is prefixed so a
 *  spreadsheet opens it as text. */
export function visualCsv(view: PolarView): string | null {
    const grid = visualGrid(view);
    if (!grid) return null;
    const quote = (value: string | number | null) => {
        if (value === null) return "";
        if (typeof value === "number") return String(value);
        const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
        return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    return [grid.header, ...grid.rows]
        .map((row) => grid.header.map((_, index) => quote(row[index] ?? null)).join(","))
        .join("\r\n");
}

/** A stored part as text: its Markdown when it holds a view, else "". */
export function visualPartMarkdown(
    part: { type?: unknown; input?: unknown } | null | undefined
): string {
    if (!isVisualPart(part)) return "";
    const visual = visualOf(part?.input);
    return visual ? visualMarkdown(visual) : "";
}
