/**
 * The toolbar button in the season's dress, like the tab, the desktop app and
 * the phone's launcher icon.
 *
 * The button is one icon for every Polaris this browser knows, so it cannot
 * follow each host in turn: it is settled by `appIconSeason` in core, the rule
 * the desktop and phone apps use. Each host is asked for its calendar at
 * `/api/polaris/season` - the report its pages hand those apps - and the mark
 * is the host's own `/season-icon/<season>-128.png`, scaled down here.
 *
 * Hosts on many versions answer: one that predates the route (404) or answers
 * anything else takes no part, exactly as the rule treats a host too old to say,
 * and with nobody taking part the button keeps its plain mark. When no host
 * could be reached at all the button is left as it is, so a browser started
 * offline does not lose the dress for a blip.
 *
 * The network, the rasterizer and the browser's icon call are passed in, so the
 * choice and every fallback can be asserted without a browser.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { readSmallJson } from "@/lib/server-identity";

export const SEASON_PATH = "/api/polaris/season";
/** The alarm that asks again, so the dress comes and goes with its dates. */
export const SEASON_ICON_ALARM = "season-icon";
export const SEASON_ICON_EVERY_MINUTES = 6 * 60;
/** The sizes the toolbar draws, on ordinary and dense screens. */
export const ACTION_ICON_SIZES = [16, 32, 48] as const;
/** The extension's own mark, the one the manifest declares. */
export const PLAIN_ICON_PATH = "icon/128.png";
/** The most of a dressed mark read: the real one is a few KiB. */
export const MAX_ICON_BYTES = 256 * 1024;
const TIMEOUT_MS = 5_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HostAnswer extends core.HostSeasonReport {
    /** Whether the host answered at all, whatever it said. */
    readonly reached: boolean;
}

const answerSchema = z.object({ calendar: z.record(z.string(), z.unknown()).nullable() });
const ruleSchema = z.object({
    enabled: z.boolean().optional(),
    window: z.object({ from: z.unknown(), to: z.unknown() }).partial().optional()
});

/**
 * A host's answer as a calendar: null when its seasons are off, undefined when
 * it is not an answer this client can read. Each season goes through core's own
 * reader, so a day its month does not have or a malformed rule is that season's
 * shipped dates rather than a calendar taken on trust.
 */
export function readCalendar(body: unknown): core.SeasonCalendar | null | undefined {
    const parsed = answerSchema.safeParse(body);
    if (!parsed.success) return undefined;
    if (parsed.data.calendar === null) return null;
    const overrides: Record<string, unknown> = {};
    for (const season of core.SEASONS) {
        const rule = ruleSchema.safeParse(parsed.data.calendar[season]);
        if (!rule.success) continue;
        overrides[season] = {
            enabled: rule.data.enabled,
            from: rule.data.window?.from,
            to: rule.data.window?.to
        };
    }
    return core.resolveSeasonCalendar(core.parseSeasonOverrides(JSON.stringify(overrides)));
}

/** What one host says about its seasons. Never throws. */
export async function askHost(origin: string, fetch: FetchLike): Promise<HostAnswer> {
    let response: Response;
    try {
        response = await fetch(`${origin}${SEASON_PATH}`, {
            credentials: "omit",
            referrerPolicy: "no-referrer",
            redirect: "error",
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch {
        return { host: origin, calendar: undefined, reached: false };
    }
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { host: origin, calendar: undefined, reached: true };
    }
    const body = await readSmallJson(response).catch(() => null);
    return { host: origin, calendar: readCalendar(body), reached: true };
}

export function seasonIconUrl(origin: string, season: core.Season): string {
    return `${origin}/season-icon/${season}-128.png`;
}

/**
 * The dressed mark as a PNG, from the first host taking part (in the rule's
 * order) that serves it. A host whose release does not know the season answers
 * 404 and the next is asked; null when none has it.
 */
export async function fetchSeasonMark(
    hosts: readonly string[],
    season: core.Season,
    fetch: FetchLike
): Promise<Blob | null> {
    for (const host of hosts) {
        try {
            const response = await fetch(seasonIconUrl(host, season), {
                credentials: "omit",
                referrerPolicy: "no-referrer",
                redirect: "error",
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });
            const type = response.headers.get("content-type") ?? "";
            const declared = Number(response.headers.get("content-length") ?? "0");
            if (!response.ok || !/^image\/png\b/i.test(type) || declared > MAX_ICON_BYTES) {
                await response.body?.cancel().catch(() => undefined);
                continue;
            }
            const blob = await response.blob();
            if (blob.size > 0 && blob.size <= MAX_ICON_BYTES) return blob;
        } catch {
            // Unreachable, refused or cut short: the next host may have it.
        }
    }
    return null;
}

/** A PNG drawn at every toolbar size. Runs in a worker, so no DOM. */
export async function rasterize(png: Blob): Promise<Record<number, ImageData>> {
    const bitmap = await createImageBitmap(png);
    try {
        const images: Record<number, ImageData> = {};
        for (const side of ACTION_ICON_SIZES) {
            const canvas = new OffscreenCanvas(side, side);
            const context = canvas.getContext("2d");
            if (!context) throw new Error("No 2D context for the toolbar icon.");
            context.imageSmoothingQuality = "high";
            context.drawImage(bitmap, 0, 0, side, side);
            images[side] = context.getImageData(0, 0, side, side);
        }
        return images;
    } finally {
        bitmap.close();
    }
}

export type IconDetails =
    | { readonly imageData: Record<number, ImageData> }
    | { readonly path: Record<number, string> };

export interface SeasonIconDeps {
    readonly origins: () => Promise<string[]>;
    readonly fetch: FetchLike;
    readonly now: () => Date;
    readonly rasterize: (png: Blob) => Promise<Record<number, ImageData>>;
    readonly setIcon: (details: IconDetails) => Promise<void>;
}

/** What a refresh did, for the tests and nothing else. */
export type SeasonIconOutcome =
    | { readonly kind: "dressed"; readonly season: core.Season }
    | { readonly kind: "plain" }
    | { readonly kind: "kept" };

const PLAIN: IconDetails = {
    path: Object.fromEntries([...ACTION_ICON_SIZES, 128].map((side) => [side, PLAIN_ICON_PATH]))
};

/**
 * One refresh at a time wins: a later one started while an earlier one is
 * still asking hosts (a server added during startup) is the one applied.
 */
export function createSeasonIcon(deps: SeasonIconDeps): () => Promise<SeasonIconOutcome> {
    let latest = 0;
    return async () => {
        const turn = ++latest;
        const settle = async (): Promise<{ details: IconDetails | null; outcome: SeasonIconOutcome }> => {
            const origins = await deps.origins();
            const answers = await Promise.all(origins.map((origin) => askHost(origin, deps.fetch)));
            if (answers.length > 0 && !answers.some((answer) => answer.reached)) {
                return { details: null, outcome: { kind: "kept" } };
            }
            const season = core.appIconSeason(answers, deps.now());
            if (!season) return { details: PLAIN, outcome: { kind: "plain" } };
            const taking = answers
                .filter((answer) => !!answer.calendar)
                .map((answer) => answer.host)
                .sort();
            const png = await fetchSeasonMark(taking, season, deps.fetch);
            const imageData = png ? await deps.rasterize(png).catch(() => null) : null;
            if (!imageData) return { details: PLAIN, outcome: { kind: "plain" } };
            return { details: { imageData }, outcome: { kind: "dressed", season } };
        };
        const { details, outcome } = await settle();
        if (turn !== latest) return { kind: "kept" };
        if (details) await deps.setIcon(details).catch(() => undefined);
        return outcome;
    };
}
