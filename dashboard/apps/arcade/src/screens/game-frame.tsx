"use client";

/**
 * A game, running in a frame of its own page (built by `scripts/build-games.mjs`
 * and served from the app's bundle), with a progress bar over it until the
 * first frame is drawn. The game's code is fetched only when this mounts, so a
 * Polaris where nobody plays never loads it.
 *
 * The frame and its page talk over `postMessage`, same origin only; the
 * messages are listed in the app's README ("Embed contract").
 */

import { z } from "zod";
import { useArcadeT } from "./i18n";
import { Button } from "@polaris/ui";
import { gameFrameSrc } from "../games/registry";
import { useEffect, useRef, useState } from "react";
import type { GameDefinition } from "../games/types";

const fromGame = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("polaris-game:progress"),
        stage: z.enum(["data", "build", "compile"]),
        done: z.number().min(0).max(1)
    }),
    z.object({ type: z.literal("polaris-game:ready") }),
    z.object({
        type: z.literal("polaris-game:failed"),
        reason: z.enum(["graphics", "data", "error"])
    })
]);

/** Where each stage sits on the one bar: the download, the city, the shaders. */
const STAGES = { data: [0, 0.3], build: [0.3, 0.55], compile: [0.55, 1] } as const;

/** A page that has said nothing this long after loading did not start. */
const SILENT_MS = 30_000;

type Load =
    | { phase: "loading"; stage: keyof typeof STAGES | null; progress: number }
    | { phase: "ready" }
    | { phase: "failed"; reason: "graphics" | "data" | "error" };

const STARTING: Load = { phase: "loading", stage: null, progress: 0 };

export function GameFrame({ game }: { game: GameDefinition }) {
    const t = useArcadeT();
    const frame = useRef<HTMLIFrameElement>(null);
    const [attempt, setAttempt] = useState(0);
    const [load, setLoad] = useState<Load>(STARTING);
    const heard = useRef(false);
    const silence = useRef<number | undefined>(undefined);
    const name = t(`games.${game.id}.name` as never);

    useEffect(() => {
        heard.current = false;
        const onMessage = (event: MessageEvent) => {
            if (event.origin !== window.location.origin) return;
            if (event.source !== frame.current?.contentWindow) return;
            const message = fromGame.safeParse(event.data);
            if (!message.success) return;
            heard.current = true;
            const data = message.data;
            if (data.type === "polaris-game:ready") setLoad({ phase: "ready" });
            else if (data.type === "polaris-game:failed") setLoad({ phase: "failed", reason: data.reason });
            else {
                const [from, to] = STAGES[data.stage];
                const progress = from + (to - from) * data.done;
                setLoad((now) =>
                    now.phase === "loading"
                        ? { phase: "loading", stage: data.stage, progress: Math.max(now.progress, progress) }
                        : now
                );
            }
        };
        window.addEventListener("message", onMessage);
        return () => {
            window.removeEventListener("message", onMessage);
            window.clearTimeout(silence.current);
        };
    }, [attempt]);

    const onFrameLoad = () => {
        window.clearTimeout(silence.current);
        silence.current = window.setTimeout(() => {
            if (!heard.current) setLoad((now) => (now.phase === "loading" ? { phase: "failed", reason: "error" } : now));
        }, SILENT_MS);
    };

    const retry = () => {
        setLoad(STARTING);
        setAttempt((n) => n + 1);
    };

    return (
        <div className="relative h-full w-full overflow-hidden bg-black">
            <iframe
                key={attempt}
                ref={frame}
                src={gameFrameSrc(game)}
                title={name}
                allow="fullscreen; gamepad"
                onLoad={onFrameLoad}
                className="absolute inset-0 h-full w-full border-0"
            />
            {load.phase !== "ready" && (
                <div className="absolute inset-0 flex items-center justify-center bg-background px-4">
                    {load.phase === "loading" ? (
                        <div className="flex w-full max-w-xs flex-col items-center gap-3 text-center">
                            <p className="w-full truncate text-sm font-medium">
                                {load.stage === "build" || load.stage === "compile"
                                    ? t("loadingCity")
                                    : t("loading", { game: name })}
                            </p>
                            <div
                                role="progressbar"
                                aria-label={t("loading", { game: name })}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={Math.round(load.progress * 100)}
                                className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                            >
                                <div
                                    className="h-full origin-left rounded-full bg-primary transition-transform duration-300"
                                    style={{ transform: `scaleX(${load.progress})` }}
                                />
                            </div>
                        </div>
                    ) : (
                        <div role="alert" className="flex max-w-sm flex-col items-center gap-3 text-center">
                            <p className="text-sm">{load.reason === "graphics" ? t("noGpu") : t("failed")}</p>
                            <Button size="sm" onClick={retry}>
                                {t("retry")}
                            </Button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
