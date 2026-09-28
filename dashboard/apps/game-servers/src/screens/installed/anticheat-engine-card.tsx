"use client";

/**
 * The switch for Polaris's anti-cheat engine, at the top of the Anti-cheat tab.
 *
 * Unlike everything else on that tab it is a plugin on the server, so a change is
 * a restart - which is said before it happens, since players get dropped.
 */

import { hostUi } from "@polaris/app-host/client";
import { Card, CardBody, Switch } from "@polaris/ui";
import { useEffect, useState, useTransition } from "react";
import type { AnticheatState } from "../../lib/minecraft/polaris-anticheat-service";
import { anticheatStateAction, setAnticheatAction } from "./anticheat-engine-actions";

const { useConfirm } = hostUi.confirmDialog;

export function AnticheatEngineCard({
    installedAppId,
    canManage
}: {
    installedAppId: string;
    canManage: boolean;
}) {
    const [state, setState] = useState<AnticheatState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();

    useEffect(() => {
        void anticheatStateAction(installedAppId).then((answer) => {
            if (answer.state) setState(answer.state);
            else setError(answer.error ?? "Could not read the anti-cheat");
        });
    }, [installedAppId]);

    async function flip(on: boolean): Promise<void> {
        // Asked before the transition: a dialog opened inside one is never drawn.
        const sure = await confirm({
            title: on ? "Turn on Polaris anti-cheat?" : "Turn off Polaris anti-cheat?",
            description:
                "The server restarts to load the change, and everybody on it is disconnected for a moment.",
            confirmLabel: on ? "Turn on and restart" : "Turn off and restart"
        });
        if (!sure) return;
        setError(null);
        startTransition(async () => {
            const result = await setAnticheatAction({ installedAppId, on });
            if (result.error) {
                setError(result.error);
                const answer = await anticheatStateAction(installedAppId);
                if (answer.state) setState(answer.state);
                return;
            }
            setState((current) => (current ? { ...current, on } : current));
            setNote(
                on
                    ? "On. The server is restarting with it."
                    : "Off. The server is restarting without it."
            );
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <p className="text-sm font-medium">Polaris anti-cheat</p>
                        <p className="text-xs text-muted-foreground">
                            Checks every player&apos;s movement and combat against what the game
                            allows, packet by packet: flying, speed, reach, killaura, no-fall and
                            the rest. Runs on the server, compensating for each player&apos;s
                            latency, so a laggy player is not taken for a cheater. On by default; a
                            server made before it gets it on its next start. While it is on, the
                            server downloads it from this Polaris each time it starts, and does not
                            start if Polaris cannot be reached.
                        </p>
                    </div>
                    <Switch
                        checked={state?.on ?? false}
                        disabled={
                            !canManage ||
                            pending ||
                            state === null ||
                            (!state.on && (!state.supported || !state.reachable))
                        }
                        onChange={(on) => void flip(on)}
                        aria-label="Polaris anti-cheat"
                    />
                </div>
                {state && !state.supported ? (
                    <p className="text-xs text-muted-foreground">
                        It runs on Paper, Purpur, Pufferfish, Leaf, Folia and Spigot. Switch the
                        server to one of them in Settings to use it.
                    </p>
                ) : state && !state.reachable && !state.on ? (
                    <p className="text-xs text-muted-foreground">
                        It needs this Polaris to have a public address: the server downloads the
                        plugin from it when it starts. Set one under Domains.
                    </p>
                ) : null}
                {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
                {error ? (
                    <p role="alert" className="text-xs text-danger">
                        {error}
                    </p>
                ) : null}
            </CardBody>
            {confirmElement}
        </Card>
    );
}
