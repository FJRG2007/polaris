"use client";

/**
 * `/games/pad`: this phone as the controller of a game open on another screen.
 * It connects with one tap to a game waiting on the same account, by the code
 * the game shows, or straight away from the game's QR (`?code=`). Connected, it
 * is a gamepad in the W3C standard layout - a stick, the triggers, the face and
 * shoulder buttons, Back and Start - and can steer by tilting. The game's
 * rumbles vibrate it.
 */

import { useArcadeT } from "./i18n";
import { findGame } from "../games/registry";
import { hostUi } from "@polaris/app-host/client";
import { Button, Input, Switch } from "@polaris/ui";
import {
    padFrame,
    stickAxes,
    stickDeadZone,
    tiltAxis,
    type PadControls
} from "./phone-pad-input";
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent
} from "react";

type Claimed = { id: string; token: string };
/** A game open on the reader's own account, waiting for a phone. */
type Waiting = { id: string; openedAt: number; game?: string; device?: string };

/** How often the list of the reader's waiting games is asked again, so a game
 *  opened on another screen turns up without a reload. */
export const WAITING_POLL_MS = 2000;
type Problem = "notFound" | "tooMany" | "failed" | "closed" | "lost" | null;

/** The face buttons in the standard layout, laid out as a pad's diamond. */
const FACE = [
    { index: 3, key: "camera", area: "col-start-2 row-start-1" },
    { index: 2, key: "horn", area: "col-start-1 row-start-2" },
    { index: 1, key: "back", area: "col-start-3 row-start-2" },
    { index: 0, key: "jump", area: "col-start-2 row-start-3" }
] as const;

/** How far the knob travels from where the thumb landed, in CSS pixels. */
const STICK_RADIUS = 56;

/** Frames sent at most this often; a frame waits for the one before it. */
const FRAME_GAP_MS = 33;

export function PhonePadScreen() {
    const t = useArcadeT();
    const locale = hostUi.i18nProvider.useLocale();
    const [mine, setMine] = useState<Waiting[] | null>(null);
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<Problem>(null);
    const [claimed, setClaimed] = useState<Claimed | null>(null);

    const claim = useCallback(async (by: { code: string } | { id: string }) => {
        // Full screen from the tap itself: no browser bar to swipe away by accident
        void document.documentElement.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {});
        setBusy(true);
        setProblem(null);
        try {
            const response = await fetch("/api/arcade/pad/claim", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(by)
            });
            if (response.ok) setClaimed((await response.json()) as Claimed);
            else
                setProblem(
                    response.status === 404
                        ? "notFound"
                        : response.status === 429
                          ? "tooMany"
                          : "failed"
                );
        } catch {
            setProblem("failed");
        } finally {
            setBusy(false);
        }
    }, []);

    // The QR's link carries the code; otherwise the games waiting on this account are offered
    useEffect(() => {
        const fromLink = new URLSearchParams(window.location.search).get("code")?.trim() ?? "";
        if (/^\d{6}$/.test(fromLink)) {
            setCode(fromLink);
            void claim({ code: fromLink });
            return;
        }
        let live = true;
        const read = () => {
            if (document.hidden) return;
            void fetch("/api/arcade/pad", { cache: "no-store" })
                .then((response) => (response.ok ? response.json() : { pads: [] }))
                .then((body: { pads?: Waiting[] }) => live && setMine(body.pads ?? []))
                .catch(() => {});
        };
        read();
        const timer = window.setInterval(read, WAITING_POLL_MS);
        document.addEventListener("visibilitychange", read);
        return () => {
            live = false;
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", read);
        };
    }, [claim]);

    const gameName = (pad: Waiting) =>
        pad.game && findGame(pad.game) ? t(`games.${pad.game}.name` as never) : t("pad.someGame");
    const device = (pad: Waiting) => pad.device || t("pad.someDevice");
    const openedAt = (pad: Waiting) =>
        new Date(pad.openedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

    if (claimed)
        return (
            <PadController
                pad={claimed}
                onEnd={(why) => {
                    setClaimed(null);
                    setProblem(why);
                }}
            />
        );

    const digits = code.replace(/\D/g, "").slice(0, 6);
    return (
        <div className="mx-auto flex w-full max-w-sm min-w-0 flex-col gap-4 px-4 py-6">
            <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold">{t("pad.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("pad.intro")}</p>
            </div>
            <section className="flex min-w-0 flex-col gap-2" aria-live="polite">
                <p className="text-sm font-medium">{t("pad.mine")}</p>
                {mine === null ? (
                    <div className="h-14 w-full animate-pulse rounded-md bg-muted" aria-busy />
                ) : mine.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("pad.none")}</p>
                ) : mine.length === 1 ? (
                    <Button
                        size="lg"
                        className="h-auto min-h-14 w-full whitespace-normal py-3 text-base"
                        disabled={busy}
                        onClick={() => void claim({ id: mine[0]!.id })}
                    >
                        {t("pad.controlOne", {
                            game: gameName(mine[0]!),
                            device: device(mine[0]!)
                        })}
                    </Button>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {mine.map((pad) => (
                            <li key={pad.id} className="min-w-0">
                                <Button
                                    variant="outline"
                                    className="h-auto w-full min-w-0 flex-col items-start gap-0.5 whitespace-normal py-2 text-left"
                                    disabled={busy}
                                    onClick={() => void claim({ id: pad.id })}
                                >
                                    <span className="w-full truncate font-medium">
                                        {gameName(pad)}
                                    </span>
                                    <span className="w-full truncate text-xs text-muted-foreground">
                                        {t("pad.waitingLine", {
                                            device: device(pad),
                                            time: openedAt(pad)
                                        })}
                                    </span>
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
            <form
                className="flex flex-col gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (digits.length === 6) void claim({ code: digits });
                }}
            >
                <label htmlFor="pad-code" className="text-sm font-medium">
                    {t("pad.code")} *
                </label>
                <Input
                    id="pad-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={7}
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/[^\d ]/g, ""))}
                    className="text-center text-2xl tracking-widest tabular-nums"
                />
                <Button type="submit" disabled={busy} aria-disabled={digits.length !== 6}>
                    {busy ? t("pad.connecting") : t("pad.connect")}
                </Button>
            </form>
            {problem && (
                <p role="alert" className="text-sm text-destructive">
                    {t(`pad.${problem}` as never)}
                </p>
            )}
        </div>
    );
}

function PadController({ pad, onEnd }: { pad: Claimed; onEnd: (why: Problem) => void }) {
    const t = useArcadeT();
    const controls = useRef<PadControls>({
        stick: { x: 0, y: 0 },
        tilt: null,
        buttons: new Array(17).fill(0)
    });
    const [tilt, setTilt] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const send = useRef<() => void>(() => {});
    const ended = useRef(false);
    const end = useRef(onEnd);
    end.current = onEnd;
    const stayHint = t("pad.stayHint");

    // Frames: the newest one, never a queue of stale ones
    useEffect(() => {
        let inFlight = false;
        let dirty = false;
        let timer: number | undefined;
        const pump = () => {
            if (inFlight || !dirty || ended.current) return;
            dirty = false;
            inFlight = true;
            fetch(`/api/arcade/pad/${pad.id}/phone`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: pad.token, frame: padFrame(controls.current) })
            })
                .then((response) => {
                    if (response.status === 404 && !ended.current) {
                        ended.current = true;
                        end.current("closed");
                    }
                })
                .catch(() => {})
                .finally(() => {
                    inFlight = false;
                    timer = window.setTimeout(pump, FRAME_GAP_MS);
                });
        };
        send.current = () => {
            dirty = true;
            pump();
        };
        const events = new EventSource(`/api/arcade/pad/${pad.id}/phone?token=${pad.token}`);
        events.onmessage = (message) => {
            let data: { kind?: string; rumble?: { strong: number; duration: number } } = {};
            try {
                data = JSON.parse(message.data);
            } catch {
                return;
            }
            if (data.kind === "rumble" && data.rumble && typeof navigator.vibrate === "function")
                navigator.vibrate(Math.round(Math.min(2000, data.rumble.duration)));
            else if (data.kind === "closed" && !ended.current) {
                ended.current = true;
                end.current("closed");
            }
        };
        events.onerror = () => {
            if (events.readyState === EventSource.CLOSED && !ended.current) {
                ended.current = true;
                end.current("lost");
            }
        };
        const release = () =>
            void fetch(`/api/arcade/pad/${pad.id}/phone`, {
                method: "POST",
                keepalive: true,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: pad.token, release: true })
            }).catch(() => {});
        window.addEventListener("pagehide", release);
        return () => {
            window.clearTimeout(timer);
            window.removeEventListener("pagehide", release);
            events.close();
            ended.current = true;
            release();
        };
    }, [pad]);

    // While playing the page holds still: no pinch or double-tap zoom, no pull to
    // refresh, no swipe back out of it, no text selection, and the screen stays on.
    useEffect(() => holdPageStill(() => setNote(stayHint)), [stayHint]);

    // Tilt steering: the phone's roll, whichever way up it is held
    useEffect(() => {
        if (!tilt) {
            controls.current.tilt = null;
            send.current();
            return;
        }
        const onTilt = (event: DeviceOrientationEvent) => {
            const angle = window.screen.orientation?.angle ?? 0;
            controls.current.tilt = tiltAxis(event.beta, event.gamma, angle);
            send.current();
        };
        window.addEventListener("deviceorientation", onTilt);
        return () => window.removeEventListener("deviceorientation", onTilt);
    }, [tilt]);

    const toggleTilt = async (on: boolean) => {
        setNote(null);
        if (!on) return setTilt(false);
        // iOS asks once, from a tap
        const ask = (
            globalThis.DeviceOrientationEvent as unknown as {
                requestPermission?: () => Promise<string>;
            }
        )?.requestPermission;
        if (typeof window.DeviceOrientationEvent === "undefined")
            return setNote(t("pad.tiltDenied"));
        if (ask && (await ask().catch(() => "denied")) !== "granted")
            return setNote(t("pad.tiltDenied"));
        setTilt(true);
    };

    const press = (index: number, down: boolean) => {
        if (controls.current.buttons[index] === (down ? 1 : 0)) return;
        controls.current.buttons[index] = down ? 1 : 0;
        send.current();
        if (down && typeof navigator.vibrate === "function") navigator.vibrate(8);
    };

    const key = (index: number, label: string, className: string, primary = false) => (
        <button
            type="button"
            key={index}
            className={`flex min-h-0 min-w-0 touch-none select-none items-center justify-center overflow-hidden rounded-xl border text-sm font-semibold transition-transform [-webkit-touch-callout:none] active:scale-95 ${
                primary
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-muted text-foreground active:bg-accent"
            } ${className}`}
            onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                press(index, true);
            }}
            onPointerUp={() => press(index, false)}
            onPointerCancel={() => press(index, false)}
            onLostPointerCapture={() => press(index, false)}
            onContextMenu={(event) => event.preventDefault()}
        >
            <span className="truncate px-1" title={label}>{label}</span>
        </button>
    );

    return (
        <div className="fixed inset-0 z-50 flex select-none flex-col gap-2 overflow-hidden overscroll-none bg-background px-[max(0.5rem,env(safe-area-inset-left))] pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-[max(0.5rem,env(safe-area-inset-top))] [-webkit-touch-callout:none] [touch-action:none]">
            <div className="flex min-w-0 shrink-0 items-center gap-2 pr-[env(safe-area-inset-right)]">
                <span className="size-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {t("pad.connected")}
                </span>
                <label className="flex min-w-0 shrink items-center gap-2 text-sm">
                    <Switch
                        checked={tilt}
                        onChange={(on) => void toggleTilt(on)}
                        aria-label={t("pad.tilt")}
                    />
                    <span className="truncate">{t("pad.tilt")}</span>
                </label>
                <Button size="sm" variant="ghost" onClick={() => end.current(null)}>
                    {t("pad.disconnect")}
                </Button>
            </div>
            {note && (
                <p
                    role="status"
                    className="shrink-0 truncate text-xs text-muted-foreground"
                    title={note}
                >
                    {note}
                </p>
            )}
            <div className="grid h-16 shrink-0 grid-cols-[1fr_1fr_auto_1fr_1fr] gap-2 landscape:h-12">
                {key(6, t("pad.brake"), "")}
                {key(4, t("pad.previous"), "")}
                <div className="flex min-w-0 gap-2">
                    {key(8, t("pad.map"), "w-14 text-xs landscape:w-16")}
                    {key(9, t("pad.menu"), "w-14 text-xs landscape:w-16")}
                </div>
                {key(5, t("pad.next"), "")}
                {key(7, t("pad.gas"), "", true)}
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 portrait:grid-cols-1 portrait:grid-rows-[minmax(0,1fr)_auto]">
                <Stick
                    label={t("pad.stick")}
                    onMove={(stick) => {
                        controls.current.stick = stick;
                        send.current();
                    }}
                />
                <div className="flex min-h-0 min-w-0 items-center justify-center">
                    <div className="grid aspect-square h-full max-h-60 max-w-full grid-cols-3 grid-rows-3 gap-1.5 portrait:h-auto portrait:w-[min(100%,14rem)]">
                        {FACE.map((button) =>
                            key(
                                button.index,
                                t(`pad.${button.key}` as never),
                                `${button.area} rounded-full`,
                                button.index === 0
                            )
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

/**
 * Holds the page still under a phone held as a controller, and returns what
 * undoes it. A back swipe lands on a step of history kept here, and `onStay`
 * says how to leave instead.
 */
function holdPageStill(onStay: () => void): () => void {
    const root = document.documentElement;
    const before = {
        root: root.style.overscrollBehavior,
        body: document.body.style.overscrollBehavior,
        overflow: document.body.style.overflow
    };
    root.style.overscrollBehavior = "none";
    document.body.style.overscrollBehavior = "none";
    document.body.style.overflow = "hidden";
    const block = (event: Event) => {
        if (event.cancelable) event.preventDefault();
    };
    const pinch = (event: TouchEvent) => {
        if (event.touches.length > 1 && event.cancelable) event.preventDefault();
    };
    const options = { passive: false } as const;
    const blocked = ["touchmove", "gesturestart", "gesturechange", "dblclick", "contextmenu"];
    for (const name of blocked) document.addEventListener(name, block, options);
    document.addEventListener("touchstart", pinch, options);
    window.history.pushState({ polarisPad: true }, "");
    const stay = () => {
        window.history.pushState({ polarisPad: true }, "");
        onStay();
    };
    window.addEventListener("popstate", stay);
    const leaving = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", leaving);
    type Lock = { release: () => Promise<void> };
    let lock: Lock | null = null;
    const wake = () => {
        if (document.visibilityState !== "visible") return;
        const wakeLock = (
            navigator as unknown as { wakeLock?: { request: (type: "screen") => Promise<Lock> } }
        ).wakeLock;
        void wakeLock
            ?.request("screen")
            .then((held) => (lock = held))
            .catch(() => {});
    };
    wake();
    document.addEventListener("visibilitychange", wake);
    return () => {
        root.style.overscrollBehavior = before.root;
        document.body.style.overscrollBehavior = before.body;
        document.body.style.overflow = before.overflow;
        for (const name of blocked) document.removeEventListener(name, block);
        document.removeEventListener("touchstart", pinch);
        window.removeEventListener("popstate", stay);
        window.removeEventListener("beforeunload", leaving);
        document.removeEventListener("visibilitychange", wake);
        void lock?.release().catch(() => {});
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        // The step kept for the back swipe goes, so one Back after leaving is one page back
        if ((window.history.state as { polarisPad?: boolean } | null)?.polarisPad)
            window.history.back();
    };
}

/**
 * A floating stick, as on phone games: it centres where the thumb lands
 * anywhere in its area, follows it, and springs back on release. One finger
 * holds it; a second one elsewhere never takes it over. The knob moves through
 * refs, so dragging it re-renders nothing.
 */
function Stick({
    label,
    onMove
}: {
    label: string;
    onMove: (stick: { x: number; y: number }) => void;
}) {
    const area = useRef<HTMLDivElement>(null);
    const base = useRef<HTMLDivElement>(null);
    const knob = useRef<HTMLDivElement>(null);
    const finger = useRef<number | null>(null);
    const origin = useRef({ x: 0, y: 0 });

    const place = (x: number, y: number, dx: number, dy: number) => {
        if (base.current) base.current.style.transform = `translate(${x}px, ${y}px)`;
        if (knob.current) knob.current.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    const rest = useCallback(() => {
        const box = area.current?.getBoundingClientRect();
        if (!box) return;
        place(box.width / 2, box.height / 2, 0, 0);
        if (base.current) base.current.style.opacity = "0.5";
    }, []);
    useEffect(() => {
        rest();
        const watch = new ResizeObserver(() => finger.current === null && rest());
        if (area.current) watch.observe(area.current);
        return () => watch.disconnect();
    }, [rest]);

    const move = (event: ReactPointerEvent<HTMLDivElement>) => {
        const box = area.current?.getBoundingClientRect();
        if (finger.current !== event.pointerId || !box) return;
        const stick = stickAxes(
            event.clientX - origin.current.x,
            event.clientY - origin.current.y,
            STICK_RADIUS
        );
        place(
            origin.current.x - box.left,
            origin.current.y - box.top,
            stick.x * STICK_RADIUS,
            stick.y * STICK_RADIUS
        );
        onMove(stickDeadZone(stick));
    };
    const letGo = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (finger.current !== event.pointerId) return;
        finger.current = null;
        rest();
        onMove({ x: 0, y: 0 });
    };

    return (
        <div
            ref={area}
            role="presentation"
            aria-label={label}
            className="relative min-h-0 min-w-0 touch-none overflow-hidden rounded-2xl bg-muted/40"
            onPointerDown={(event) => {
                if (finger.current !== null) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                finger.current = event.pointerId;
                const box = event.currentTarget.getBoundingClientRect();
                // The base stays whole inside the area, however close to its edge the thumb lands
                const margin = Math.min(STICK_RADIUS + 8, box.width / 2, box.height / 2);
                origin.current = {
                    x: Math.min(Math.max(event.clientX, box.left + margin), box.right - margin),
                    y: Math.min(Math.max(event.clientY, box.top + margin), box.bottom - margin)
                };
                if (base.current) base.current.style.opacity = "1";
                move(event);
            }}
            onPointerMove={move}
            onPointerUp={letGo}
            onPointerCancel={letGo}
            onLostPointerCapture={letGo}
        >
            <div
                ref={base}
                className="pointer-events-none absolute left-0 top-0 transition-opacity"
                aria-hidden
            >
                <div
                    className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-border bg-background/60"
                    style={{ width: STICK_RADIUS * 2 + 40, height: STICK_RADIUS * 2 + 40 }}
                />
                <div ref={knob} className="absolute left-0 top-0 will-change-transform">
                    <div className="size-16 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow-lg" />
                </div>
            </div>
            <span className="pointer-events-none absolute inset-x-0 bottom-2 truncate px-2 text-center text-xs text-muted-foreground">
                {label}
            </span>
        </div>
    );
}
