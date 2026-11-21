/**
 * Which satellite imagery the map tile proxy fetches, and with what key.
 *
 * The choice is an integration row (`satellite-imagery`): the provider in its
 * config, the operator's key envelope-encrypted as its secret, like every other
 * provider key here. Nothing in this module is sent to a browser except an
 * `ImageryView` - what the map draws and credits, never the key or the address
 * a tile came from.
 *
 * Order: `POLARIS_MAP_IMAGERY_URL` when the instance names its own source (kept
 * as it always worked), then the administrator's keyed provider, then the free
 * Sentinel-2 default. A keyed provider that refuses the key or runs out of its
 * quota is stood down for a few minutes - every map falls back to the default
 * and the Integrations screen says why - and tried again after.
 *
 * Server-only.
 */

import { z } from "zod";
import { getSetting, setSetting } from "@/lib/setting-store";
import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";
import {
    IMAGERY,
    TILE_SOURCES,
    DEFAULT_IMAGERY_VIEW,
    type ImageryView,
    type KeyedImageryProvider
} from "@/lib/map-layers";

export const IMAGERY_INTEGRATION = "satellite-imagery";
/** Where the last provider-wide refusal is kept for the Integrations screen. */
const FAILURE_KEY = "map.imagery.failure";
/** How long a refused provider is stood down before it is asked again. */
const STAND_DOWN_MS = 5 * 60 * 1000;
/** How long the resolved choice is reused before the database is read again. */
const RESOLVED_MS = 30 * 1000;

/** Each keyed provider's tile address; `{key}` is filled URL-encoded. Sources in `lib/map-layers.ts`. */
const KEYED_TEMPLATES: Readonly<Record<KeyedImageryProvider, string>> = {
    maptiler: "https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key={key}",
    esri: "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token={key}"
};

/** Why a keyed provider's tile did not come back. */
export type ImageryFailureReason = "refused" | "limit" | "unreachable";

export interface ImageryFailure {
    readonly provider: KeyedImageryProvider;
    readonly reason: ImageryFailureReason;
    readonly status: number | null;
    readonly at: string;
}

/** The source the proxy uses right now. */
export type ResolvedImagery =
    | { readonly kind: "default"; readonly view: ImageryView }
    | { readonly kind: "custom"; readonly view: ImageryView; readonly template: string }
    | {
          readonly kind: "keyed";
          readonly view: ImageryView;
          readonly provider: KeyedImageryProvider;
          readonly key: string;
      };

/** The instance's own imagery address, when `POLARIS_MAP_IMAGERY_URL` names a usable one. */
export function customImageryTemplate(): string | null {
    const configured = process.env[TILE_SOURCES.imagery.env]?.trim();
    return configured && /^https?:\/\//.test(configured) && configured.includes("{z}") ? configured : null;
}

/** A keyed provider's tile address. Pure; exported for tests. */
export function keyedTileUrl(provider: KeyedImageryProvider, key: string, z: number, x: number, y: number): string {
    return KEYED_TEMPLATES[provider]
        .replace("{z}", String(z))
        .replace("{x}", String(x))
        .replace("{y}", String(y))
        .replace("{key}", encodeURIComponent(key));
}

/** What a provider's answer status means. Pure; exported for tests. */
export function failureReason(status: number | null): ImageryFailureReason {
    if (status === 401 || status === 403 || status === 498 || status === 499) return "refused";
    if (status === 402 || status === 429) return "limit";
    return "unreachable";
}

/** Whether a failure stands the whole provider down rather than one tile. */
export function providerWide(reason: ImageryFailureReason): boolean {
    return reason !== "unreachable";
}

// Per process: the resolved choice, briefly, and a provider stood down after a
// refusal, keyed by the view's version so a newly saved key is asked at once.
let resolved: { at: number; value: ResolvedImagery } | null = null;
let stoodDown: { version: string; until: number } | null = null;

/** Forget what this process resolved; after a save, and in tests. */
export function forgetImagery(): void {
    resolved = null;
    stoodDown = null;
}

async function resolve(): Promise<ResolvedImagery> {
    const template = customImageryTemplate();
    if (template) {
        // The instance's own source: drawn and credited as it always was.
        return { kind: "custom", template, view: { ...DEFAULT_IMAGERY_VIEW, provider: "custom", version: "custom" } };
    }
    const state = await getIntegrationState(IMAGERY_INTEGRATION);
    const provider = state?.config.provider;
    if (!state?.enabled || (provider !== "maptiler" && provider !== "esri")) {
        return { kind: "default", view: DEFAULT_IMAGERY_VIEW };
    }
    const key = await getIntegrationSecret(IMAGERY_INTEGRATION);
    if (!key) return { kind: "default", view: DEFAULT_IMAGERY_VIEW };
    const stamp = state.updatedAt ? Date.parse(state.updatedAt).toString(36) : "0";
    const info = IMAGERY[provider];
    return {
        kind: "keyed",
        provider,
        key,
        view: { provider, nativeMaxZoom: info.nativeMaxZoom, credits: info.credits, version: `${provider}-${stamp}` }
    };
}

/** The imagery source the proxy fetches from, falling back to the default while a keyed one is stood down. */
export async function activeImagery(): Promise<ResolvedImagery> {
    if (!resolved || Date.now() - resolved.at > RESOLVED_MS) resolved = { at: Date.now(), value: await resolve() };
    const value = resolved.value;
    if (value.kind === "keyed" && stoodDown?.version === value.view.version && Date.now() < stoodDown.until) {
        return { kind: "default", view: DEFAULT_IMAGERY_VIEW };
    }
    return value;
}

/**
 * A keyed provider's tile failed. A refusal or an exhausted quota stands the
 * provider down for every map and is kept for the Integrations screen; a single
 * missing or slow tile only falls back for that tile.
 */
export async function noteImageryFailure(
    imagery: Extract<ResolvedImagery, { kind: "keyed" }>,
    status: number | null
): Promise<ImageryFailureReason> {
    const reason = failureReason(status);
    if (!providerWide(reason)) return reason;
    const already = stoodDown?.version === imagery.view.version && Date.now() < stoodDown.until;
    stoodDown = { version: imagery.view.version, until: Date.now() + STAND_DOWN_MS };
    if (!already) {
        const failure: ImageryFailure = { provider: imagery.provider, reason, status, at: new Date().toISOString() };
        await setSetting(FAILURE_KEY, JSON.stringify(failure)).catch(() => undefined);
    }
    return reason;
}

/** A keyed provider answered again after being stood down: the record of its refusal goes. */
export async function noteImagerySuccess(imagery: Extract<ResolvedImagery, { kind: "keyed" }>): Promise<void> {
    if (stoodDown?.version !== imagery.view.version) return;
    stoodDown = null;
    await clearImageryFailure().catch(() => undefined);
}

/** The last provider-wide refusal, for the Integrations screen; null when none is on record. */
export async function readImageryFailure(): Promise<ImageryFailure | null> {
    const raw = await getSetting(FAILURE_KEY);
    if (!raw) return null;
    let stored: unknown = null;
    try {
        stored = JSON.parse(raw);
    } catch {
        return null;
    }
    const parsed = z
        .object({
            provider: z.enum(["maptiler", "esri"]),
            reason: z.enum(["refused", "limit", "unreachable"]),
            status: z.number().int().nullable(),
            at: z.string()
        })
        .safeParse(stored);
    return parsed.success ? parsed.data : null;
}

/** Forget the recorded refusal: a new key was saved, or the provider answered again. */
export async function clearImageryFailure(): Promise<void> {
    await setSetting(FAILURE_KEY, null);
}

export const TILE_HEADERS = {
    "user-agent": "Polaris (self-hosted chat location tiles)",
    accept: "image/png,image/jpeg,image/*"
} as const;

/**
 * Ask the provider for one low-zoom tile with this key, which is what saving a
 * key does before it is kept. Never throws; the reason is what the screen says.
 */
export async function testImageryKey(
    provider: KeyedImageryProvider,
    key: string
): Promise<{ ok: true } | { ok: false; reason: ImageryFailureReason; status: number | null }> {
    try {
        const response = await fetch(keyedTileUrl(provider, key, 1, 1, 0), {
            signal: AbortSignal.timeout(8_000),
            redirect: "error",
            headers: TILE_HEADERS
        });
        const type = response.headers.get("content-type") ?? "";
        await response.body?.cancel().catch(() => undefined);
        if (response.ok && type.startsWith("image/")) return { ok: true };
        // Esri answers a bad token with a 200 and a JSON error body.
        const status = response.ok ? 498 : response.status;
        return { ok: false, reason: failureReason(status), status };
    } catch {
        return { ok: false, reason: "unreachable", status: null };
    }
}
