/**
 * The line over Polar's empty screen and the prompts under it, built from
 * templates rather than asked of a model: the local hour, the day of the week
 * and a few dates of the year decide which templates apply, what the person
 * can reach decides which prompts are offered, and a seed picked once per page
 * load decides among them. Pure: the same inputs always give the same words.
 *
 * Client-safe.
 */

/** A message key under `polar.greetings`, with the values it takes. */
export interface Greeting {
    readonly key: string;
    readonly values: Readonly<Record<string, string>>;
}

export interface PhraseContext {
    /** The reader's local time. */
    readonly now: Date;
    /** Any non-negative integer, chosen once per page load. */
    readonly seed: number;
}

type Moment = "night" | "morning" | "afternoon" | "evening";
type Occasion = "christmas" | "newYearsEve" | "newYear";
type Day = "monday" | "friday" | "weekend";

/** The part of the day an hour falls in. */
export function momentOf(hour: number): Moment {
    if (hour < 6) return "night";
    if (hour < 12) return "morning";
    if (hour < 18) return "afternoon";
    return "evening";
}

/** A date of the year that gets words of its own, if today is one. */
export function occasionOf(now: Date): Occasion | null {
    const month = now.getMonth() + 1;
    const day = now.getDate();
    if (month === 12 && day >= 24 && day <= 26) return "christmas";
    if (month === 12 && day === 31) return "newYearsEve";
    if (month === 1 && day <= 2) return "newYear";
    return null;
}

/** The kind of day it is, for the few templates that care. */
export function dayOf(now: Date): Day | null {
    const day = now.getDay();
    if (day === 1) return "monday";
    if (day === 5) return "friday";
    if (day === 0 || day === 6) return "weekend";
    return null;
}

/** How many templates each group has in the messages: plain, then with a name. */
export const GREETINGS: Readonly<Record<"any" | Moment | Day | Occasion, { plain: number; named: number }>> = {
    any: { plain: 5, named: 3 },
    night: { plain: 2, named: 1 },
    morning: { plain: 2, named: 2 },
    afternoon: { plain: 2, named: 1 },
    evening: { plain: 2, named: 2 },
    monday: { plain: 1, named: 1 },
    friday: { plain: 1, named: 1 },
    weekend: { plain: 1, named: 1 },
    christmas: { plain: 1, named: 1 },
    newYearsEve: { plain: 1, named: 1 },
    newYear: { plain: 1, named: 1 }
};

function keysOf(group: keyof typeof GREETINGS, named: boolean): string[] {
    const counts = GREETINGS[group];
    const plain = Array.from({ length: counts.plain }, (_, index) => `${group}.plain${index + 1}`);
    if (!named) return plain;
    return [...plain, ...Array.from({ length: counts.named }, (_, index) => `${group}.named${index + 1}`)];
}

/** The first word of a name, or empty when there is none to use. */
export function firstNameOf(name: string | null | undefined): string {
    return name?.trim().split(/\s+/)[0] ?? "";
}

/** Every greeting that fits this moment, in a fixed order. */
export function greetingCandidates(now: Date, name: string | null): string[] {
    const named = firstNameOf(name).length > 0;
    const occasion = occasionOf(now);
    // A holiday is the one thing worth saying on it.
    if (occasion) return keysOf(occasion, named);
    const day = dayOf(now);
    return [...keysOf(momentOf(now.getHours()), named), ...(day ? keysOf(day, named) : []), ...keysOf("any", named)];
}

/** The greeting for this page load. */
export function pickGreeting(context: PhraseContext & { name: string | null }): Greeting {
    const candidates = greetingCandidates(context.now, context.name);
    const key = candidates[Math.abs(Math.floor(context.seed)) % candidates.length] ?? "any.plain1";
    return { key, values: key.includes(".named") ? { name: firstNameOf(context.name) } : {} };
}

/** The app groups whose prompts a tool category unlocks. */
const APP_GROUPS = ["mail", "calendar", "chat", "files", "productivity", "development", "home", "games"] as const;

/**
 * Chat prompts by what they need. `any` needs nothing but a model; an app's
 * group needs one of that app's tools among the ones the person may use (the
 * tools' categories, `lib/mcp/scope-table.ts`); `weather` needs the weather
 * tool, which is only offered while the web is allowed.
 */
export const CHAT_PROMPTS = {
    any: ["tools", "explain", "draft", "brainstorm", "summarizeText", "decide"],
    morning: ["planDay"],
    afternoon: ["focus"],
    evening: ["wrapUp"],
    night: ["tomorrow"],
    monday: ["planWeek"],
    friday: ["weekReview"],
    weekend: ["weekendPlan"],
    christmas: ["holidayMessage"],
    newYearsEve: ["yearReview"],
    newYear: ["yearGoals"],
    mail: ["unreadMail"],
    calendar: ["calendarToday"],
    chat: ["catchUpChats"],
    files: ["findFile"],
    productivity: ["myTasks"],
    development: ["deployments"],
    home: ["homeStatus"],
    games: ["gameServers"],
    weather: ["weather"]
} as const satisfies Record<"any" | Moment | Day | Occasion | (typeof APP_GROUPS)[number] | "weather", readonly string[]>;

/** Prompts for a coding task, which need only a repository or folder. */
export const CODE_PROMPTS = ["explainRepo", "fixBug", "addTests", "reviewChanges", "updateDeps", "cleanUp"] as const;

/** The weather tool's name (`lib/polar/weather.ts`), kept here so this stays client-safe. */
export const WEATHER_TOOL_NAME = "polar_weather";

/** What the person can reach, read from the tools they may use. */
export interface PromptReach {
    /** The categories of the tools offered to this person. */
    readonly categories: ReadonlySet<string>;
    /** Whether the weather tool is among them. */
    readonly weather: boolean;
    /** Whether the screen behind Polar can be read. */
    readonly page: boolean;
}

/** The reach a tool list gives: the categories it covers and whether it has the weather. */
export function reachOf(
    tools: Readonly<Record<string, { readonly category?: string }>>,
    page: boolean
): PromptReach {
    const categories = new Set<string>();
    for (const entry of Object.values(tools)) if (entry.category) categories.add(entry.category);
    return { categories, weather: WEATHER_TOOL_NAME in tools, page };
}

/** Takes `count` distinct keys from `pool`, starting where the seed points. */
function draw(pool: readonly string[], seed: number, count: number, taken: string[]): void {
    for (let step = 0; taken.length < count && step < pool.length; step++) {
        const key = pool[(seed + step) % pool.length]!;
        if (!taken.includes(key)) taken.push(key);
    }
}

/**
 * Up to `count` distinct chat prompts (`polar.suggestions.<key>`) for this page
 * load: the page first when it can be read, then one about something the
 * person can reach, then one that fits the moment, then ones that always work.
 */
export function pickChatPrompts(context: PhraseContext & { reach: PromptReach; count?: number }): string[] {
    const count = context.count ?? 3;
    const seed = Math.abs(Math.floor(context.seed));
    const picked: string[] = context.reach.page ? ["page"] : [];
    const reachable = [
        ...APP_GROUPS.filter((group) => context.reach.categories.has(group)).flatMap((group) => CHAT_PROMPTS[group]),
        ...(context.reach.weather ? CHAT_PROMPTS.weather : [])
    ];
    draw(reachable, seed, Math.min(count, picked.length + 1), picked);
    const occasion = occasionOf(context.now);
    const day = dayOf(context.now);
    const timely = [
        ...(occasion ? CHAT_PROMPTS[occasion] : []),
        ...(day ? CHAT_PROMPTS[day] : []),
        ...CHAT_PROMPTS[momentOf(context.now.getHours())]
    ];
    draw(timely, seed, Math.min(count, picked.length + 1), picked);
    draw(CHAT_PROMPTS.any, seed, count, picked);
    return picked.slice(0, count);
}

/** Up to `count` distinct coding prompts (`polar.code.prompts.<key>`) for this page load. */
export function pickCodePrompts(context: Pick<PhraseContext, "seed"> & { count?: number }): string[] {
    const picked: string[] = [];
    draw(CODE_PROMPTS, Math.abs(Math.floor(context.seed)), context.count ?? 3, picked);
    return picked;
}
