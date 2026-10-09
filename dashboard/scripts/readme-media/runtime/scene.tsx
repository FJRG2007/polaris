/**
 * What a README scene is.
 *
 * A scene is one screen of the real dashboard, in the state worth showing, with
 * the data it would have been given. It never draws anything itself: `render`
 * returns the app's own components, and the fixtures stand in for the server.
 */

import type { ReactNode } from "react";
import type { StreamEvent } from "./stream";

export type SceneLocale = "en-US" | "es-ES";
export type SceneTheme = "dark" | "light";

/** Everything a fixture may depend on, fixed for the whole capture. */
export interface SceneContext {
    readonly locale: SceneLocale;
    readonly theme: SceneTheme;
    /** The moment the picture is taken. The capture freezes the clock here. */
    readonly now: number;
    /** English or Spanish, by the scene's locale: fixture text is written in both. */
    readonly say: (en: string, es: string) => string;
}

/** An answer for a server action, by the action's exported name. */
export type ActionFixture = (...args: never[]) => unknown;

/** An answer for a request to the dashboard's own API: "GET /api/x" -> body. */
export type ApiFixture = (request: { url: URL; method: string; body: unknown }) => unknown;

export interface SceneDefinition {
    /** The image name, stable across runs: the README links to it. */
    readonly id: string;
    /** The route the screen lives at, which is what `usePathname` answers. */
    readonly path: string;
    /** The route's dynamic segments, which is what `useParams` answers. */
    readonly params?: Record<string, string>;
    readonly actions?: (ctx: SceneContext) => Record<string, ActionFixture>;
    readonly api?: (ctx: SceneContext) => Record<string, ApiFixture>;
    /** What each live stream says once opened, by path: the log lines, the
     *  metrics, whatever the screen follows rather than asks for. */
    readonly streams?: (ctx: SceneContext) => Record<string, readonly StreamEvent[]>;
    readonly render: (ctx: SceneContext) => ReactNode;
    /** What a reader does once the screen is up, before the picture: open a
     *  panel, pick a tab. Runs after the screen settles; the capture lets the
     *  scene settle again before taking it. */
    readonly prepare?: (ctx: SceneContext) => void | Promise<void>;
    /**
     * For an animation: the steps to play, one per frame group. Each one changes
     * the scene (through the hooks the scene itself exposes) and says how long
     * the frame it produces is held.
     */
    readonly animation?: {
        readonly frames: number;
        /** Run before frame `index` is taken. */
        readonly step: (index: number) => void | Promise<void>;
        /** Milliseconds frame `index` stays on screen. */
        readonly hold: (index: number) => number;
        /** Milliseconds of the scene's clock that pass between the step and its
         *  picture - long enough for what the step set off to finish. */
        readonly advance?: (index: number) => number;
    };
}

export function defineScene(scene: SceneDefinition): SceneDefinition {
    return scene;
}
