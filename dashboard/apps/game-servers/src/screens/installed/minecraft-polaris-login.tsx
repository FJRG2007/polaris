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

/**
 * The mod's state on one server, read when `enabled`.
 *
 * `initial` is what the page was rendered with, so the first paint already has
 * it; without one, the last answer this tab kept is used, read after hydration
 * so the server's markup and the browser's first render agree. `refreshMs` reads
 * it again on that interval, for a screen that has to notice the server checking
 * in after a restart.
 */
export function useLoginState(
    installedAppId: string,
    initial: LoginState | null,
    enabled: boolean,
    refreshMs?: number
) {
    const [state, setState] = useState<LoginState | null>(enabled ? initial : null);
    const [loaded, setLoaded] = useState(state !== null);
    const [error, setError] = useState<string | null>(null);
    // Whether the first render already holds what the server read for the page.
    // Asking again on mount would be the same answer a moment later, and on the
    // Minecraft tabs that one call headed the queue every other action waits in.
    const t = useGameText("minecraft");
    const seeded = useRef(enabled && initial !== null);

    useEffect(() => {
        if (!enabled || initial) return;
        const kept = readSnapshot<LoginState>(snapshotKey(installedAppId), SNAPSHOT_MS)?.value;
        if (!kept) return;
        setState((current) => current ?? kept);
        setLoaded(true);
    }, [enabled, initial, installedAppId]);

    const reload = useCallback(async () => {
        const result = await loginStateAction(installedAppId);
        if (result.state) {
            writeSnapshot(snapshotKey(installedAppId), result.state);
            setState(result.state);
            setError(null);
        } else {
            setError(result.error ?? t("login.readFailed"));
        }
        setLoaded(true);
    }, [installedAppId, t]);

    useEffect(() => {
        if (!enabled) return;
        if (seeded.current) seeded.current = false;
        else void reload();
        if (!refreshMs) return;
        const timer = setInterval(() => void reload(), refreshMs);
        return () => clearInterval(timer);
    }, [enabled, reload, refreshMs]);

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
