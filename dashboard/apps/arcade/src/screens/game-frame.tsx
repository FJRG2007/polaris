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
 * has moved on to a field of the page meanwhile, and takes it back at the first
 * driving key pressed outside it.
 *
 * The frame and its page talk over `postMessage`; the messages are listed in
 * the app's README ("Embed contract"). Inside a call, the call is the host: it
 * is told where the reader goes and hands back the other players, and lends the
 * game its microphone and hang-up, so the game's menu can offer them to a
 * gamepad, a keyboard or a touch screen that cannot reach the call's bar.
 *
 * In a call the frame is sandboxed without `allow-same-origin`, so its page
 * has an origin of its own (`"null"`) rather than the dashboard's. A
 * same-origin frame runs on the page's own main thread: building the city and
 * drawing it every frame held that thread for seconds at a time, and the call
 * around it - and the rest of the tab - froze with it. Cross-origin, the
 * browser can run the game in a process of its own. An opaque origin has no
 * storage, though, so on its own page, with no call to keep running, the game
 * stays same-origin and keeps its saved place, quality and sound. Messages are
 * told apart by the window they come from, and sent to that one window only.
 */

import { z } from "zod";
import { useArcadeT } from "./i18n";
import { hostUi } from "@polaris/app-host/client";
import { gameMessages } from "../../messages";
import { isDrivingKey, mayTakeFocus } from "./frame-focus";
import { Button } from "@polaris/ui";
import { gameFrameSrc } from "../games/registry";
import { useEffect, useRef, useState } from "react";
import { PhonePadBridge } from "./phone-pad-bridge";
import type { GameDefinition } from "../games/types";
import type { AppHostTypes } from "@polaris/app-host";

type CallActivityHost = AppHostTypes["CallActivityHost"];

const fromGame = z.discriminatedUnion("type", [
    z.object({ type: z.literal("polaris-game:hello") }),
    z.object({ type: z.literal("polaris-game:exit") }),
    // The reader chose Play with others on the game's start screen
    z.object({ type: z.literal("polaris-game:rooms") }),
    z.object({
        type: z.literal("polaris-game:progress"),
        stage: z.enum(["data", "build", "compile"]),
        done: z.number().min(0).max(1)
    }),
    z.object({ type: z.literal("polaris-game:ready") }),
    // The reader used one of the call's controls from the game's menu
    z.object({
        type: z.literal("polaris-game:call-action"),
        action: z.enum(["mic", "leave-game", "leave-call"])
    }),
    z.object({
        type: z.literal("polaris-game:failed"),
        reason: z.enum(["graphics", "data", "error"])
    }),
    // Checked by the call before it goes anywhere.
    z.object({ type: z.literal("polaris-game:state") }).passthrough()
]);

/** What the game's page may do in a call: run its scripts and hold the mouse
 *  for looking around on foot, nothing else. Not `allow-same-origin` - see the
 *  top of this file. */
export const FRAME_SANDBOX = "allow-scripts allow-pointer-lock";

/** Whether a message came from this frame's page: its window, from the
 *  sandbox's opaque origin (or this origin, for a browser without one). */
export function fromFrame(
    event: Pick<MessageEvent, "origin" | "source">,
    frame: Window | null | undefined
): boolean {
    if (!frame || event.source !== frame) return false;
    return event.origin === "null" || event.origin === window.location.origin;
}

/** A page that has said nothing this long after loading did not start. */
const SILENT_MS = 30_000;

/** A load that has said nothing new for this long has stopped: every step of it
 *  reports progress well within it, on a slow machine too. Not counted while the
 *  tab is hidden, where the browser slows the game's timers down. */
export const STALLED_MS = 120_000;

type Load =
    // Nothing from the game yet: this draws the loading line
    | { phase: "starting" }
    // The game draws its own loading screen
    | { phase: "loading" }
    | { phase: "ready" }
    | { phase: "failed"; reason: "graphics" | "data" | "error" };

const STARTING: Load = { phase: "starting" };

/** Play with others as the game's start screen offers it: on, shown off
 *  with the reason, or not at all. */
export type FrameRooms = "on" | "denied" | "off";

export function GameFrame({
    game,
    call,
    onExit,
    rooms = "off",
    onRooms
}: {
    game: GameDefinition;
    call?: CallActivityHost;
    /** Where the game's Exit game goes; without it the game's menu has no Exit. */
    onExit?: () => void;
    /** Whether the start screen offers Play with others; never in a call. */
    rooms?: FrameRooms;
    /** Called when the reader chooses Play with others in the game. */
    onRooms?: () => void;
}) {
    const t = useArcadeT();
    const locale = hostUi.i18nProvider.useLocale();
    const frame = useRef<HTMLIFrameElement>(null);
    const [attempt, setAttempt] = useState(0);
    const [load, setLoad] = useState<Load>(STARTING);
    const heard = useRef(false);
    const silence = useRef<number | undefined>(undefined);
    const stall = useRef<number | undefined>(undefined);
    const name = t(`games.${game.id}.name` as never);
    const host = useRef(call);
    host.current = call;
    const exit = useRef(onExit);
    exit.current = onExit;
    const canExit = Boolean(onExit);
    const roomsOffer: FrameRooms = call || !onRooms ? "off" : rooms;
    const roomsNow = useRef(roomsOffer);
    roomsNow.current = roomsOffer;
    const openRooms = useRef(onRooms);
    openRooms.current = onRooms;
    const setup = useRef<() => void>(() => {});
    setup.current = () =>
        frame.current?.contentWindow?.postMessage(
            {
                type: "polaris-game:setup",
                locale,
                messages: gameMessages(locale, game.id),
                exit: canExit,
                rooms: roomsOffer
            },
            // The sandboxed page's origin is opaque, so no origin names it: the
            // message goes to that one window, whatever it is showing.
            "*"
        );

    useEffect(() => {
        heard.current = false;
        // Started again by every message until the city is up or the load failed
        const watch = () => {
            window.clearTimeout(stall.current);
            stall.current = window.setTimeout(() => {
                if (document.hidden) return watch();
                setLoad((now) =>
                    now.phase === "loading" || now.phase === "starting"
                        ? { phase: "failed", reason: "error" }
                        : now
                );
            }, STALLED_MS);
        };
        const onMessage = (event: MessageEvent) => {
            if (!fromFrame(event, frame.current?.contentWindow)) return;
            const message = fromGame.safeParse(event.data);
            if (!message.success) return;
            heard.current = true;
            const data = message.data;
            if (data.type === "polaris-game:ready" || data.type === "polaris-game:failed")
                window.clearTimeout(stall.current);
            else if (data.type === "polaris-game:progress" || data.type === "polaris-game:hello")
                watch();
            if (data.type === "polaris-game:state") host.current?.onState(data);
            else if (data.type === "polaris-game:hello") setup.current();
            else if (data.type === "polaris-game:exit") exit.current?.();
            else if (data.type === "polaris-game:rooms") {
                if (roomsNow.current === "on") openRooms.current?.();
            }
            else if (data.type === "polaris-game:call-action") {
                const controls = host.current?.controls;
                if (data.action === "mic") controls?.toggleMic();
                else if (data.action === "leave-game") controls?.leaveGame();
                else controls?.leaveCall();
            } else if (data.type === "polaris-game:ready") {
                setLoad({ phase: "ready" });
                // Keys go to the frame that has the focus: without this they stayed with the page
                // and the car ignored them until something in the game was clicked
                if (mayTakeFocus(document.activeElement)) frame.current?.focus();
            } else if (data.type === "polaris-game:failed")
                setLoad({ phase: "failed", reason: data.reason });
            else setLoad((now) => (now.phase === "starting" ? { phase: "loading" } : now));
        };
        window.addEventListener("message", onMessage);
        return () => {
            window.removeEventListener("message", onMessage);
            window.clearTimeout(silence.current);
            window.clearTimeout(stall.current);
        };
    }, [attempt]);

    // A change of language while the game is open reaches it too
    useEffect(() => {
        setup.current();
    }, [locale, canExit, roomsOffer]);

    // In a call, once the city is up: join, then draw the others wherever the
    // call says they are.
    const ready = load.phase === "ready";
    const seat = call?.self.id;

    // The keyboard can stay with the page however the game started, or go back
    // to it with a click: the first driving key hands it over, and holding the
    // key repeats into the frame.
    useEffect(() => {
        if (!ready) return;
        const onKey = (event: KeyboardEvent) => {
            if (isDrivingKey(event) && mayTakeFocus(document.activeElement)) frame.current?.focus();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [ready]);

    useEffect(() => {
        const session = host.current;
        if (!ready || !seat || !session) return;
        const post = (message: unknown) => frame.current?.contentWindow?.postMessage(message, "*");
        post({ type: "polaris-game:join", self: session.self });
        const stop = session.onPlayers((players) =>
            post({ type: "polaris-game:players", players })
        );
        return () => {
            stop();
            post({ type: "polaris-game:leave" });
        };
    }, [ready, seat, attempt]);

    // The call's controls, offered in the game's menu: whether there are any,
    // and the microphone as it is now, again whenever it changes.
    const micOn = call?.controls?.micOn;
    useEffect(() => {
        if (!ready) return;
        frame.current?.contentWindow?.postMessage(
            micOn === undefined
                ? { type: "polaris-game:call", controls: false }
                : { type: "polaris-game:call", controls: true, micOn },
            "*"
        );
    }, [ready, micOn, attempt]);

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
        <div
            className="relative h-full w-full overflow-hidden bg-black"
            // The browser's menu over the game's frame or its loading and failure screens; text stays copyable
            onContextMenu={(event) => {
                if (!(event.target as Element).closest("p, a, input, textarea"))
                    event.preventDefault();
            }}
        >
            <iframe
                key={attempt}
                ref={frame}
                src={gameFrameSrc(game)}
                title={name}
                allow="fullscreen; gamepad"
                sandbox={call ? FRAME_SANDBOX : undefined}
                onLoad={onFrameLoad}
                className="absolute inset-0 h-full w-full border-0"
            />
            <PhonePadBridge frame={frame} />
            {(load.phase === "starting" || load.phase === "failed") && (
                <div className="absolute inset-0 flex items-center justify-center bg-black px-4 text-white">
                    {load.phase === "starting" ? (
                        <p
                            role="status"
                            className="w-full max-w-xs truncate text-center text-sm font-medium"
                        >
                            {/* In a call the bar above the frame already names the game */}
                            {call ? t("loadingInCall") : t("loading", { game: name })}
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
