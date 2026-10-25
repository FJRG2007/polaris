"use client";

/**
 * A game, running in a frame of its own page (built by `scripts/build-games.mjs`
 * and served from the app's bundle). This draws a plain loading line only until
 * the game's page reports progress: from then on the game's own loading screen,
 * with its steps and tips, is the one on screen. The game's code is fetched only
 * when this mounts, so a Polaris where nobody plays never loads it.
 *
 * The game asks for its words (`polaris-game:hello`) and is sent the reader's
 * language and catalog (`polaris-game:setup`), again whenever the language
 * changes. Once the city is up the frame takes the keyboard, unless the reader
 * has moved on to a field of the page meanwhile.
 *
 * The frame and its page talk over `postMessage`, same origin only; the
 * messages are listed in the app's README ("Embed contract"). Inside a call,
 * the call is the host: it is told where the reader goes and hands back the
 * other players.
 */

import { z } from "zod";
import { useArcadeT } from "./i18n";
import { hostUi } from "@polaris/app-host/client";
import { gameMessages } from "../../messages";
import { mayTakeFocus } from "./frame-focus";
import { Button } from "@polaris/ui";
import { gameFrameSrc } from "../games/registry";
import { useEffect, useRef, useState } from "react";
import type { GameDefinition } from "../games/types";
import type { AppHostTypes } from "@polaris/app-host";

type CallActivityHost = AppHostTypes["CallActivityHost"];

const fromGame = z.discriminatedUnion("type", [
    z.object({ type: z.literal("polaris-game:hello") }),
    z.object({ type: z.literal("polaris-game:exit") }),
    z.object({
        type: z.literal("polaris-game:progress"),
        stage: z.enum(["data", "build", "compile"]),
        done: z.number().min(0).max(1)
    }),
    z.object({ type: z.literal("polaris-game:ready") }),
    z.object({
        type: z.literal("polaris-game:failed"),
        reason: z.enum(["graphics", "data", "error"])
    }),
    // Checked by the call before it goes anywhere.
    z.object({ type: z.literal("polaris-game:state") }).passthrough()
]);

/** A page that has said nothing this long after loading did not start. */
const SILENT_MS = 30_000;

type Load =
    // Nothing from the game yet: this draws the loading line
    | { phase: "starting" }
    // The game draws its own loading screen
    | { phase: "loading" }
    | { phase: "ready" }
    | { phase: "failed"; reason: "graphics" | "data" | "error" };

const STARTING: Load = { phase: "starting" };

export function GameFrame({
    game,
    call,
    onExit
}: {
    game: GameDefinition;
    call?: CallActivityHost;
    /** Where the game's Exit game goes; without it the game's menu has no Exit. */
    onExit?: () => void;
}) {
    const t = useArcadeT();
    const locale = hostUi.i18nProvider.useLocale();
    const root = useRef<HTMLDivElement>(null);
    const frame = useRef<HTMLIFrameElement>(null);
    const [attempt, setAttempt] = useState(0);
    const [load, setLoad] = useState<Load>(STARTING);
    const heard = useRef(false);
    const silence = useRef<number | undefined>(undefined);
    const name = t(`games.${game.id}.name` as never);
    const host = useRef(call);
    host.current = call;
    const exit = useRef(onExit);
    exit.current = onExit;
    const canExit = Boolean(onExit);
    const setup = useRef<() => void>(() => {});
    setup.current = () =>
        frame.current?.contentWindow?.postMessage(
            {
                type: "polaris-game:setup",
                locale,
                messages: gameMessages(locale, game.id),
                exit: canExit
            },
            window.location.origin
        );

    useEffect(() => {
        heard.current = false;
        const onMessage = (event: MessageEvent) => {
            if (event.origin !== window.location.origin) return;
            if (event.source !== frame.current?.contentWindow) return;
            const message = fromGame.safeParse(event.data);
            if (!message.success) return;
            heard.current = true;
            const data = message.data;
            if (data.type === "polaris-game:state") host.current?.onState(data);
            else if (data.type === "polaris-game:hello") setup.current();
            else if (data.type === "polaris-game:exit") exit.current?.();
            else if (data.type === "polaris-game:ready") {
                setLoad({ phase: "ready" });
                // Keys go to the frame that has the focus: without this they stayed with the page
                // and the car ignored them until something in the game was clicked
                if (mayTakeFocus(document.activeElement, root.current)) frame.current?.focus();
            }
            else if (data.type === "polaris-game:failed")
                setLoad({ phase: "failed", reason: data.reason });
            else setLoad((now) => (now.phase === "starting" ? { phase: "loading" } : now));
        };
        window.addEventListener("message", onMessage);
        return () => {
            window.removeEventListener("message", onMessage);
            window.clearTimeout(silence.current);
        };
    }, [attempt]);

    // A change of language while the game is open reaches it too
    useEffect(() => {
        setup.current();
    }, [locale, canExit]);

    // In a call, once the city is up: join, then draw the others wherever the
    // call says they are.
    const ready = load.phase === "ready";
    const seat = call?.self.id;
    useEffect(() => {
        const session = host.current;
        if (!ready || !seat || !session) return;
        const post = (message: unknown) =>
            frame.current?.contentWindow?.postMessage(message, window.location.origin);
        post({ type: "polaris-game:join", self: session.self });
        const stop = session.onPlayers((players) =>
            post({ type: "polaris-game:players", players })
        );
        return () => {
            stop();
            post({ type: "polaris-game:leave" });
        };
    }, [ready, seat, attempt]);

    const onFrameLoad = () => {
        window.clearTimeout(silence.current);
        silence.current = window.setTimeout(() => {
            if (!heard.current)
                setLoad((now) =>
                    now.phase === "starting" || now.phase === "loading"
                        ? { phase: "failed", reason: "error" }
                        : now
                );
        }, SILENT_MS);
    };

    const retry = () => {
        setLoad(STARTING);
        setAttempt((n) => n + 1);
    };

    return (
        <div ref={root} className="relative h-full w-full overflow-hidden bg-black">
            <iframe
                key={attempt}
                ref={frame}
                src={gameFrameSrc(game)}
                title={name}
                allow="fullscreen; gamepad"
                onLoad={onFrameLoad}
                className="absolute inset-0 h-full w-full border-0"
            />
            {(load.phase === "starting" || load.phase === "failed") && (
                <div className="absolute inset-0 flex items-center justify-center bg-black px-4 text-white">
                    {load.phase === "starting" ? (
                        <p role="status" className="w-full max-w-xs truncate text-center text-sm font-medium">
                            {t("loading", { game: name })}
                        </p>
                    ) : (
                        <div
                            role="alert"
                            className="flex max-w-sm flex-col items-center gap-3 text-center"
                        >
                            <p className="text-sm">
                                {load.reason === "graphics" ? t("noGpu") : t("failed")}
                            </p>
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
