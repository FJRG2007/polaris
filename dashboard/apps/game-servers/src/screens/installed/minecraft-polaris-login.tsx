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
import { TriangleAlert } from "lucide-react";
import { loginStateAction } from "./minecraft-login-actions";
import { useCallback, useEffect, useState } from "react";
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
            setError(result.error ?? "Could not read the login state");
        }
        setLoaded(true);
    }, [installedAppId]);

    useEffect(() => {
        if (!enabled) return;
        void reload();
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
    const registered = state.players.length;

    return (
        <div className="flex flex-col gap-3">
            {state.health === "silent" ? (
                <p className="flex items-start gap-2 rounded-md border border-danger-edge bg-danger-soft px-3 py-2 text-xs text-danger-ink">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    <span>
                        The server has been up for over three minutes without reaching Polaris, so
                        nobody can join it.
                        {state.seenAt ? (
                            <>
                                {" "}
                                Last reached <RelativeTime iso={state.seenAt} />.
                            </>
                        ) : (
                            " It has never reached it."
                        )}{" "}
                        Restarting the server tries again. If it keeps happening, the machine it
                        runs on cannot reach this Polaris at its address.
                    </span>
                </p>
            ) : (
                <p className="text-xs text-muted-foreground">
                    {state.health === "ok" && state.seenAt ? (
                        <>
                            Polaris login checked in <RelativeTime iso={state.seenAt} />.
                            {state.outdated &&
                                " The server runs an older build; the new one installs when it restarts."}
                        </>
                    ) : (
                        "Waiting for the server to start and check in."
                    )}
                </p>
            )}

            <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                Players register with{" "}
                <span className="font-mono">/register &lt;password&gt; &lt;password&gt;</span>, come
                back with <span className="font-mono">/login &lt;password&gt;</span> and change it
                with <span className="font-mono">/changepassword &lt;old&gt; &lt;new&gt;</span>. A
                password with spaces or symbols goes in double quotes.
            </p>

            <p className="text-xs text-muted-foreground">
                {registered === 0
                    ? "Nobody has set a password yet."
                    : `${registered} ${registered === 1 ? "player has" : "players have"} set a password.`}{" "}
                {onOpenPlayers ? (
                    <button
                        type="button"
                        onClick={onOpenPlayers}
                        className="text-primary hover:underline"
                    >
                        See who, and reset one, in Players
                    </button>
                ) : (
                    "Players shows who, and resets one."
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
