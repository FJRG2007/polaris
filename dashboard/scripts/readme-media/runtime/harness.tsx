/**
 * The page every scene is drawn in.
 *
 * `?scene=<id>&theme=dark|light&locale=en-US|es-ES` picks what to draw. The page
 * then sets up what the dashboard's root layout would have - the theme class,
 * the language and every message catalog - answers the scene's actions and API
 * requests from its fixtures, and renders the scene's own components.
 *
 * Anything a component asks for that the scene did not answer lands in
 * `window.__MISSING__`, and the capture refuses to save a picture of a screen
 * that was missing data.
 */

import { SCENES } from "../scenes";
import { chromeActions, chromeApi } from "../fixtures/chrome";
import { scenePath } from "./route";
import { SceneEventSource, scriptStream } from "./stream";
import enUS from "@/../messages/en-US";
import esES from "@/../messages/es-ES";
import { createRoot } from "react-dom/client";
import type { Namespaces } from "@polaris/core";
import { I18nProvider } from "@/components/i18n/i18n-provider";
import type { SceneContext, SceneLocale, SceneTheme } from "./scene";

declare global {
    interface Window {
        __SCENE_LIST__?: { id: string }[];
        __scene?: {
            ready: boolean;
            frames: number;
            step: (index: number) => Promise<void>;
            hold: (index: number) => number;
            advance: (index: number) => number;
            prepare: () => Promise<void>;
        };
    }
}

const params = new URLSearchParams(location.search);
const locale = (params.get("locale") === "es-ES" ? "es-ES" : "en-US") satisfies SceneLocale;
const theme = (params.get("theme") === "light" ? "light" : "dark") satisfies SceneTheme;
const scene = SCENES.find((candidate) => candidate.id === params.get("scene"));

const ctx: SceneContext = {
    locale,
    theme,
    // The capture freezes the clock before the page loads, so this is the
    // scene's moment on every run.
    now: Date.now(),
    say: (en, es) => (locale === "es-ES" ? es : en)
};

function missing(what: string) {
    (globalThis.__MISSING__ ??= []).push(what);
}

/** The dashboard's own API, answered from the scene. A path is matched with its
 *  `:param` segments, so `GET /api/chat/channels/:id/messages` covers them all. */
function patchFetch(
    routes: Record<string, (request: { url: URL; method: string; body: unknown }) => unknown>
) {
    const table = Object.entries(routes).map(([key, answer]) => {
        const [method, pattern] = key.split(" ") as [string, string];
        const source = pattern
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            .replace(/:[a-zA-Z]+/g, "[^/]+");
        return { method, match: new RegExp(`^${source}$`), answer };
    });
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
        const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            location.href
        );
        // Another site is answered from the scene too, by its full address: a
        // picture never waits on, or tells anything to, the network.
        const local = url.origin === location.origin;
        if (local && !url.pathname.startsWith("/api/")) return original(input, init);
        const address = local ? url.pathname : `${url.origin}${url.pathname}`;
        const method = (init?.method ?? "GET").toUpperCase();
        const route = table.find((row) => row.method === method && row.match.test(address));
        if (!route) {
            missing(`${method} ${address}`);
            return new Response(JSON.stringify({ error: "not in this scene" }), { status: 404 });
        }
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        const answer = await route.answer({ url, method, body });
        return answer instanceof Response ? answer : Response.json(answer);
    };
}

function start() {
    if (params.get("scene") === "__list__") {
        window.__SCENE_LIST__ = SCENES.map((one) => ({ id: one.id }));
        return;
    }
    document.documentElement.lang = locale;
    document.documentElement.className = theme === "light" ? "light" : "";
    (window as unknown as { EventSource: unknown }).EventSource = SceneEventSource;
    const root = createRoot(document.getElementById("root")!);
    if (!scene) {
        missing(`scene ${params.get("scene")}`);
        return;
    }
    scenePath.set(scene.path, scene.params ?? {});
    globalThis.__ACTIONS__ = { ...chromeActions(), ...scene.actions?.(ctx) } as never;
    patchFetch({ ...chromeApi(ctx), ...scene.api?.(ctx) } as never);
    for (const [path, events] of Object.entries(scene.streams?.(ctx) ?? {}))
        scriptStream(path, events);
    const messages = (locale === "es-ES" ? esES : enUS) as unknown as Namespaces;
    root.render(
        <I18nProvider locale={locale} messages={messages}>
            {scene.render(ctx)}
        </I18nProvider>
    );
    const animation = scene.animation;
    window.__scene = {
        ready: true,
        frames: animation?.frames ?? 1,
        step: async (index) => {
            await animation?.step(index);
        },
        hold: (index) => animation?.hold(index) ?? 0,
        advance: (index) => animation?.advance?.(index) ?? 400,
        prepare: async () => {
            await scene.prepare?.(ctx);
        }
    };
}

start();
