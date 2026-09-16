"use client";

/**
 * Polaris's own login mod, inside the join-password card.
 *
 * Where a build exists (NeoForge 1.21.4 today) and Polaris has a public address,
 * it is the only login the card manages: what a new server gets, and what Turn
 * on installs - replacing a Modrinth guard the server still carries. It gives
 * players real commands and text passwords where the modded project only has
 * `/trigger` and numbers, and it keeps the passwords here, where a forgotten one
 * can be reset.
 *
 * What it costs is said before it is turned on: the mod asks Polaris on every
 * join, so a server that cannot reach Polaris lets nobody in, and does not start.
 * The card watches for that - the mod checks in every minute, and a server that
 * has been up a while without checking in is shown as the outage it is.
 */

import { Button, Skeleton } from "@polaris/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { useCallback, useEffect, useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import { Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import type { LoginState } from "@/lib/apps/minecraft/polaris-login-service";
import { forgetLoginAction, loginStateAction } from "./minecraft-login-actions";
import { readSnapshot, writeSnapshot, dropSnapshots } from "@/lib/snapshot-cache";

const SNAPSHOT_MS = 30_000;
const snapshotKey = (installedAppId: string) => `minecraft-login:${installedAppId}`;

/** The mod's state on one server, read when `enabled`, from cache first. */
export function useLoginState(installedAppId: string, enabled: boolean) {
    const [state, setState] = useState<LoginState | null>(() =>
        enabled
            ? (readSnapshot<LoginState>(snapshotKey(installedAppId), SNAPSHOT_MS)?.value ?? null)
            : null
    );
    const [loaded, setLoaded] = useState(state !== null);
    const [error, setError] = useState<string | null>(null);

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
        if (enabled) void reload();
    }, [enabled, reload]);

    const invalidate = useCallback(() => {
        dropSnapshots(snapshotKey(installedAppId));
        return reload();
    }, [installedAppId, reload]);

    return { state, loaded: !enabled || loaded, error, reload: invalidate };
}

/** What the card shows while the mod is on. */
export function LoginDetails({
    installedAppId,
    state,
    onChanged
}: {
    installedAppId: string;
    state: LoginState;
    onChanged: () => void;
}) {
    const [confirm, confirmElement] = useConfirm();
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function forget(player: string): Promise<void> {
        const asked = await confirm({
            title: `Reset ${player}'s password?`,
            description: `${player} sets a new one the next time they join.`,
            confirmLabel: "Reset password",
            danger: true
        });
        if (!asked) return;
        setBusy(player);
        setError(null);
        const result = await forgetLoginAction({ installedAppId, player });
        setBusy(null);
        if (result.error) setError(result.error);
        else onChanged();
    }

    return (
        <div className="flex flex-col gap-3">
            {confirmElement}
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
                            Polaris login {state.modVersion ? `${state.modVersion} ` : ""}checked in{" "}
                            <RelativeTime iso={state.seenAt} />.
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

            <div className="flex flex-col gap-1">
                <p className="text-xs font-medium">Registered players</p>
                {state.players.length === 0 ? (
                    <p className="text-xs text-muted-foreground">Nobody has registered yet.</p>
                ) : (
                    <ul className="flex flex-col divide-y divide-border">
                        {state.players.map((player) => (
                            <li
                                key={player.name}
                                className="flex items-center gap-2 py-1.5 text-sm"
                            >
                                <span
                                    className="min-w-0 flex-1 truncate font-mono"
                                    title={player.name}
                                >
                                    {player.name}
                                </span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    {player.lastLoginAt ? (
                                        <>
                                            In{" "}
                                            <RelativeTime
                                                iso={player.lastLoginAt}
                                                formatStyle="narrow"
                                            />
                                        </>
                                    ) : (
                                        "Never logged in"
                                    )}
                                </span>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label={`Reset ${player.name}'s password`}
                                    title={`Reset ${player.name}'s password`}
                                    disabled={busy !== null}
                                    onClick={() => void forget(player.name)}
                                >
                                    {busy === player.name ? (
                                        <Loader2 className="size-4 animate-spin" />
                                    ) : (
                                        <RotateCcw className="size-4" />
                                    )}
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
                {error && <p className="text-sm text-danger">{error}</p>}
            </div>
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
