"use client";

/**
 * Polaris's own login mod, inside the join-password card.
 *
 * Where a build exists (a plugin for Paper, Purpur and Spigot, a mod for
 * NeoForge 1.21.4) and Polaris has a public address, it is the only login the
 * card manages: what a new server gets, and what Turn on installs - replacing a
 * Modrinth guard the server still carries. It gives players real commands and
 * text passwords where the modded project only has `/trigger` and numbers, and
 * it keeps the passwords here, where a forgotten one can be reset.
 *
 * What it costs is said before it is turned on: the mod asks Polaris on every
 * join, so a server that cannot reach Polaris lets nobody in, and does not start.
 * The card watches for that - the mod checks in every minute, and a server that
 * has been up a while without checking in is shown as the outage it is.
 */

import { Skeleton } from "@polaris/ui";
import { useGameText } from "../game-text";
import { TriangleAlert } from "lucide-react";
import { loginStateAction } from "./minecraft-login-actions";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { LoginState } from "../../lib/minecraft/polaris-login-service";
import { hostUi } from "@polaris/app-host/client";

const { RelativeTime } = hostUi.relativeTime;
const { readSnapshot, writeSnapshot, dropSnapshots } = hostUi.snapshotCache;

const SNAPSHOT_MS = 30_000;
const snapshotKey = (installedAppId: string) => `minecraft-login:${installedAppId}`;

/** The login state to hand a component that would otherwise read its own. */
export type LoginStateHandle = ReturnType<typeof useLoginState>;

/** How soon Polaris login's state is read again while somebody is on the server
 *  without a password - at the prompt to set one, which is the change a screen
 *  showing them is waiting for. */
export const LOGIN_LIVE_MS = 5_000;
/** And otherwise: a password reset elsewhere, a server checking in after a
 *  restart. The mod itself checks in every minute. */
export const LOGIN_IDLE_MS = 30_000;

/** Whether somebody on the server has no password yet, with the mod on: what
 *  the quicker of the two cadences above is for. Names are compared folded,
 *  because the game and the mod may not spell one the same way. */
export function awaitingPassword(
    state: LoginState | null,
    online: readonly string[] | undefined
): boolean {
    if (state?.on !== true || !online?.length) return false;
    const set = new Set(state.players.map((player) => player.name.toLowerCase()));
    return online.some((name) => !set.has(name.toLowerCase()));
}

/** The shortest gap between two reads that coming back to the tab starts: a
 *  window that regains focus and becomes visible fires both events at once. */
const RETURN_GAP_MS = 2_000;

/**
 * The mod's state on one server, read when `enabled`.
 *
 * `initial` is what the page was rendered with, so the first paint already has
 * it; without one, the last answer this tab kept is used, read after hydration
 * so the server's markup and the browser's first render agree. `refreshMs` reads
 * it again that long after each read finishes, for a screen that has to notice a
 * player setting their password or the server checking in after a restart; given
 * as a function of what is held, it can quicken while something is happening.
 *
 * Read the way the server's own poll is: a hidden tab asks nothing, and coming
 * back to it - visible again, or focused again from the game's window, which is
 * where a password is set - reads at once rather than an interval late. An answer
 * equal to what is held is not swapped in, so nothing that draws it re-renders,
 * and an answer older than one already applied is dropped.
 */
export function useLoginState(
    installedAppId: string,
    initial: LoginState | null,
    enabled: boolean,
    refreshMs?: number | ((state: LoginState | null) => number)
) {
    const [state, setState] = useState<LoginState | null>(enabled ? initial : null);
    const [loaded, setLoaded] = useState(state !== null);
    const [error, setError] = useState<string | null>(null);
    // Whether the first render already holds what the server read for the page.
    // Asking again on mount would be the same answer a moment later, and on the
    // Minecraft tabs that one call headed the queue every other action waits in.
    const t = useGameText("minecraft");
    const seeded = useRef(enabled && initial !== null);
    // Which read was asked for last, and which one's answer is on screen.
    const asked = useRef(0);
    const shown = useRef(0);
    // When the beat last asked (or took the page's answer), for which server.
    const lastRead = useRef<{ id: string; at: number } | null>(null);
    // A number, so the beat restarts only when the cadence itself changes.
    const every = typeof refreshMs === "function" ? refreshMs(state) : refreshMs;

    useEffect(() => {
        if (!enabled || initial) return;
        const kept = readSnapshot<LoginState>(snapshotKey(installedAppId), SNAPSHOT_MS)?.value;
        if (!kept) return;
        setState((current) => current ?? kept);
        setLoaded(true);
    }, [enabled, initial, installedAppId]);

    const reload = useCallback(async () => {
        const ticket = ++asked.current;
        let result: Awaited<ReturnType<typeof loginStateAction>>;
        try {
            result = await loginStateAction(installedAppId);
        } catch {
            // A read that did not come back - a restart, a dropped connection -
            // is tried again on the next beat, over what is already on screen.
            return;
        }
        if (ticket < shown.current) return;
        shown.current = ticket;
        const next = result.state;
        if (next) {
            writeSnapshot(snapshotKey(installedAppId), next);
            setState((current) =>
                current && JSON.stringify(current) === JSON.stringify(next) ? current : next
            );
            setError(null);
        } else {
            setError(result.error ?? t("login.readFailed"));
        }
        setLoaded(true);
    }, [installedAppId, t]);

    useEffect(() => {
        if (!enabled) return;
        let live = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let inFlight = false;
        const sinceRead = (): number =>
            lastRead.current?.id === installedAppId
                ? Date.now() - lastRead.current.at
                : Number.POSITIVE_INFINITY;
        // Scheduled from the end of a read rather than on a fixed interval, so a
        // slow answer never has the next question queued up behind it.
        const cycle = async (): Promise<void> => {
            if (timer) clearTimeout(timer);
            timer = undefined;
            if (!document.hidden && !inFlight) {
                lastRead.current = { id: installedAppId, at: Date.now() };
                if (seeded.current) seeded.current = false;
                else {
                    inFlight = true;
                    await reload();
                    inFlight = false;
                }
            }
            if (live && every && !document.hidden) timer = setTimeout(() => void cycle(), every);
        };
        const onReturn = (): void => {
            if (!live || document.hidden || inFlight) return;
            const since = sinceRead();
            if (since >= RETURN_GAP_MS) void cycle();
            else if (every && !timer) timer = setTimeout(() => void cycle(), RETURN_GAP_MS - since);
        };
        // A cadence that changed because of the answer just read waits out the
        // rest of the new one rather than asking the same question again at once.
        const since = sinceRead();
        if (every && since < every && !document.hidden)
            timer = setTimeout(() => void cycle(), every - since);
        else void cycle();
        document.addEventListener("visibilitychange", onReturn);
        window.addEventListener("focus", onReturn);
        return () => {
            live = false;
            document.removeEventListener("visibilitychange", onReturn);
            window.removeEventListener("focus", onReturn);
            if (timer) clearTimeout(timer);
        };
    }, [enabled, installedAppId, reload, every]);

    const invalidate = useCallback(() => {
        dropSnapshots(snapshotKey(installedAppId));
        return reload();
    }, [installedAppId, reload]);

    return { state, loaded: !enabled || loaded, error, reload: invalidate };
}

/** What the card shows while the mod is on. */
export function LoginDetails({
    state,
    onOpenPlayers
}: {
    state: LoginState;
    /** Where each player's password is shown and reset. */
    onOpenPlayers?: () => void;
}) {
    const t = useGameText("minecraft");
    const registered = state.players.length;

    return (
        <div className="flex flex-col gap-3">
            {state.health === "silent" ? (
                <p className="flex items-start gap-2 rounded-md border border-danger-edge bg-danger-soft px-3 py-2 text-xs text-danger-ink">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    <span>
                        {t("login.theServerHasBeenUp")}
                        {state.seenAt ? (
                            <>
                                {" "}
                                {t.rich<ReactNode>("login.lastReached", {
                                    time: () => <RelativeTime key="time" iso={state.seenAt!} />
                                })}
                            </>
                        ) : (
                            ` ${t("login.neverReached")}`
                        )}{" "}
                        {t("login.restartingTheServerTriesAgain")}
                    </span>
                </p>
            ) : (
                <p className="text-xs text-muted-foreground">
                    {state.health === "ok" && state.seenAt ? (
                        <>
                            {t.rich<ReactNode>("login.checkedIn", {
                                time: () => <RelativeTime key="time" iso={state.seenAt!} />
                            })}
                            {state.outdated && ` ${t("login.outdated")}`}
                        </>
                    ) : (
                        t("login.waitingForTheServerTo")
                    )}
                </p>
            )}

            <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                {t.rich<ReactNode>("login.commandsHelp", {
                    register: () => (
                        <span key="register" className="font-mono">
                            {`/register <${t("login.words.password")}> <${t("login.words.password")}>`}
                        </span>
                    ),
                    login: () => (
                        <span key="login" className="font-mono">
                            {`/login <${t("login.words.password")}>`}
                        </span>
                    ),
                    change: () => (
                        <span key="change" className="font-mono">
                            {`/changepassword <${t("login.words.old")}> <${t("login.words.new")}>`}
                        </span>
                    )
                })}
            </p>

            <p className="text-xs text-muted-foreground">
                {registered === 0
                    ? t("login.nobodyHasSetAPassword")
                    : t("login.registeredCount", { count: registered })}{" "}
                {onOpenPlayers ? (
                    <button
                        type="button"
                        onClick={onOpenPlayers}
                        className="text-primary hover:underline"
                    >
                        {t("login.seeWhoAndResetOne")}
                    </button>
                ) : (
                    t("login.playersShowsWhoAndResets")
                )}
            </p>
        </div>
    );
}

/** The shape of the details while the first read is out. */
export function LoginSkeleton() {
    return (
        <div className="flex flex-col gap-2" aria-hidden>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-10 w-full" />
        </div>
    );
}
