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
import { padFrame, stickAxes, tiltAxis, type PadControls } from "./phone-pad-input";
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
export const WAITING_POLL_MS = 4000;
type Problem = "notFound" | "tooMany" | "failed" | "closed" | "lost" | null;

/** Where each on-screen button sits in the standard layout. */
const BUTTONS = [
    { index: 6, key: "brake" },
    { index: 7, key: "gas" },
    { index: 4, key: "previous" },
    { index: 5, key: "next" },
    { index: 2, key: "horn" },
    { index: 3, key: "camera" },
    { index: 1, key: "back" },
    { index: 0, key: "jump" }
] as const;

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
                        {t("pad.controlOne", { game: gameName(mine[0]!), device: device(mine[0]!) })}
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
                                    <span className="w-full truncate font-medium">{gameName(pad)}</span>
                                    <span className="w-full truncate text-xs text-muted-foreground">
                                        {t("pad.waitingLine", { device: device(pad), time: openedAt(pad) })}
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
    const [knob, setKnob] = useState({ x: 0, y: 0 });
    const send = useRef<() => void>(() => {});
    const ended = useRef(false);
    const end = useRef(onEnd);
    end.current = onEnd;

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
        controls.current.buttons[index] = down ? 1 : 0;
        send.current();
        if (down && typeof navigator.vibrate === "function") navigator.vibrate(8);
    };

    const stickBox = useRef<HTMLDivElement>(null);
    const moveStick = (event: ReactPointerEvent<HTMLDivElement>) => {
        const box = stickBox.current?.getBoundingClientRect();
        if (!box) return;
        const stick = stickAxes(
            event.clientX - (box.left + box.width / 2),
            event.clientY - (box.top + box.height / 2),
            box.width / 2
        );
        controls.current.stick = stick;
        setKnob(stick);
        send.current();
    };
    const releaseStick = () => {
        controls.current.stick = { x: 0, y: 0 };
        setKnob({ x: 0, y: 0 });
        send.current();
    };

    const hold = (index: number) => ({
        onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            press(index, true);
        },
        onPointerUp: () => press(index, false),
        onPointerCancel: () => press(index, false),
        onContextMenu: (event: { preventDefault: () => void }) => event.preventDefault()
    });

    return (
        <div className="fixed inset-0 z-50 flex select-none flex-col gap-3 bg-background p-3 [touch-action:none]">
            <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {t("pad.connected")}
                </span>
                <label className="flex shrink-0 items-center gap-2 text-sm">
                    <Switch
                        checked={tilt}
                        onChange={(on) => void toggleTilt(on)}
                        aria-label={t("pad.tilt")}
                    />
                    <span className="truncate">{t("pad.tilt")}</span>
                </label>
                <Button size="sm" variant="outline" {...hold(8)}>
                    {t("pad.map")}
                </Button>
                <Button size="sm" variant="outline" {...hold(9)}>
                    {t("pad.menu")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => end.current(null)}>
                    {t("pad.disconnect")}
                </Button>
            </div>
            {note && (
                <p role="status" className="truncate text-xs text-muted-foreground" title={note}>
                    {note}
                </p>
            )}
            <div className="flex min-h-0 flex-1 items-stretch gap-3">
                <div
                    ref={stickBox}
                    role="presentation"
                    aria-label={t("pad.stick")}
                    className="relative aspect-square max-h-full min-w-0 flex-1 self-center rounded-full border border-border bg-muted"
                    onPointerDown={(event) => {
                        event.currentTarget.setPointerCapture(event.pointerId);
                        moveStick(event);
                    }}
                    onPointerMove={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId))
                            moveStick(event);
                    }}
                    onPointerUp={releaseStick}
                    onPointerCancel={releaseStick}
                >
                    <div
                        className="pointer-events-none absolute h-1/3 w-1/3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/70"
                        style={{ left: `${50 + knob.x * 33}%`, top: `${50 + knob.y * 33}%` }}
                    />
                </div>
                <div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
                    {BUTTONS.map((button) => (
                        <Button
                            key={button.index}
                            variant={
                                button.index === 7 || button.index === 0 ? "primary" : "outline"
                            }
                            className="h-full min-h-12 min-w-0 truncate"
                            {...hold(button.index)}
                        >
                            {t(`pad.${button.key}` as never)}
                        </Button>
                    ))}
                </div>
            </div>
        </div>
    );
}
