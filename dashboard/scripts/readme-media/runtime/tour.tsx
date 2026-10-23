/**
 * A scene played as a short loop of a feature in use: its screen, then what a
 * hand does on it - a row opened, a tab picked, another screen of the same app.
 *
 * Every view is a scene's own `render`, so every frame is the app's real
 * components. A beat may switch to another view (mounted fresh at its own
 * route, the way following a link mounts it), do what a reader would do on
 * the one showing, or move the fixtures on (`beat()`) so the screen reads its
 * data again and shows what changed.
 */

import { scenePath } from "./route";
import type { SceneContext, SceneDefinition } from "./scene";
import { Fragment, useEffect, useSyncExternalStore } from "react";

export interface Beat {
    /** Which view is on screen, by its place in the tour's scenes; the last one when left out. */
    readonly view?: number;
    /** Mount the view afresh, so it reads its data again at this beat. */
    readonly fresh?: boolean;
    /** What a hand does once the view is up. */
    readonly run?: (ctx: SceneContext) => void | Promise<void>;
    /** Milliseconds the frame stays on screen. */
    readonly hold: number;
    /** Milliseconds of the scene's clock between the beat and its picture. */
    readonly advance?: number;
}

let current = 0;
const listeners = new Set<() => void>();

/** The beat on screen, for a fixture whose data moves as the loop plays. */
export function beat(): number {
    return current;
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** The beat React has drawn, which trails `current` by a render. */
let drawn = 0;
const drawWatchers = new Set<() => void>();

function drawnAt(index: number): Promise<void> {
    if (drawn === index) return Promise.resolve();
    return new Promise((resolve) => {
        const check = () => {
            if (drawn !== index) return;
            drawWatchers.delete(check);
            resolve();
        };
        drawWatchers.add(check);
    });
}

/**
 * `views[0]` played as `beats`: its id, route and still are the first view's,
 * and every view's answers are merged so each screen finds what it asks for.
 */
export function tourScene(
    views: readonly SceneDefinition[],
    beats: readonly Beat[]
): SceneDefinition {
    const viewOf = (index: number): number => {
        for (let at = index; at >= 0; at--) {
            const view = beats[at]?.view;
            if (view !== undefined) return view;
        }
        return 0;
    };
    // The beat the view was last mounted at: a fresh beat mounts it again.
    const mountKey = (index: number): string => {
        let at = index;
        while (at > 0 && !beats[at]!.fresh && viewOf(at - 1) === viewOf(index)) at--;
        return `${viewOf(index)}-${at}`;
    };
    let context: SceneContext | null = null;

    function Tour({ ctx }: { ctx: SceneContext }) {
        const index = useSyncExternalStore(subscribe, () => current);
        useEffect(() => {
            drawn = index;
            for (const watcher of [...drawWatchers]) watcher();
        }, [index]);
        return <Fragment key={mountKey(index)}>{views[viewOf(index)]!.render(ctx)}</Fragment>;
    }

    const first = views[0]!;
    const merge = <T,>(pick: (view: SceneDefinition) => Record<string, T> | undefined) =>
        Object.assign({}, ...[...views].reverse().map(pick)) as Record<string, T>;
    return {
        id: first.id,
        path: first.path,
        params: first.params,
        actions: (ctx) => merge((view) => view.actions?.(ctx)),
        api: (ctx) => merge((view) => view.api?.(ctx)),
        streams: (ctx) => merge((view) => view.streams?.(ctx)),
        render: (ctx) => {
            context = ctx;
            return <Tour ctx={ctx} />;
        },
        animation: {
            frames: beats.length,
            step: async (index) => {
                const view = views[viewOf(index)]!;
                scenePath.set(view.path, view.params ?? {});
                current = index;
                for (const listener of listeners) listener();
                await drawnAt(index);
                await beats[index]!.run?.(context!);
            },
            hold: (index) => beats[index]!.hold,
            advance: (index) => beats[index]!.advance ?? 1200
        }
    };
}
