"use client";

/**
 * The switch for Polaris's anti-cheat engine, at the top of the Anti-cheat tab.
 *
 * Unlike everything else on that tab it is a plugin on the server, so a change is
 * a restart - which is said before it happens, since players get dropped.
 */

import { hostUi } from "@polaris/app-host/client";
import { useGameText } from "../game-text";
import { Card, CardBody, Switch } from "@polaris/ui";
import { useEffect, useState, useTransition } from "react";
import type { AnticheatState } from "../../lib/minecraft/polaris-anticheat-service";
import { anticheatStateAction, setAnticheatAction } from "./anticheat-engine-actions";

const { useConfirm } = hostUi.confirmDialog;
const { writeSnapshot } = hostUi.snapshotCache;
const { useKeptSnapshot } = hostUi.liveRead;
const { mergeUnchanged } = hostUi.structuralMerge;

/** How old the kept switch may be and still paint first on a revisit. */
const KEPT_STATE_MS = 24 * 3_600_000;

export function AnticheatEngineCard({
    installedAppId,
    canManage
}: {
    installedAppId: string;
    canManage: boolean;
}) {
    const t = useGameText("minecraft");
    // What this tab last read paints first, so the switch is not blank on a
    // revisit; the read below replaces it when it moved.
    const stateKey = `anticheat-engine:${installedAppId}`;
    const [state, setState] = useState<AnticheatState | null>(null);
    useKeptSnapshot<AnticheatState>(stateKey, KEPT_STATE_MS, (kept) =>
        setState((current) => current ?? kept.value)
    );
    // Whether this visit's own read has answered. The kept switch only paints:
    // flipping it restarts the server, so it waits on the fresh state.
    const [heard, setHeard] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();

    useEffect(() => {
        if (heard && state) writeSnapshot(stateKey, state);
    }, [heard, stateKey, state]);

    useEffect(() => {
        void anticheatStateAction(installedAppId).then((answer) => {
            const found = answer.state;
            if (found) {
                setState((current) => mergeUnchanged(current, found));
                setHeard(true);
            } else {
                setState(null);
                setError(answer.error ?? t("engine.readFailed"));
            }
        });
    }, [installedAppId]);

    async function flip(on: boolean): Promise<void> {
        // Asked before the transition: a dialog opened inside one is never drawn.
        const sure = await confirm({
            title: on ? t("engine.turnOnPolarisAntiCheat") : t("engine.turnOffPolarisAntiCheat"),
            description: t("engine.theServerRestartsToLoad"),
            confirmLabel: on ? t("engine.turnOnAndRestart") : t("engine.turnOffAndRestart")
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
            setNote(on ? t("engine.turnedOn") : t("engine.turnedOff"));
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <p className="text-sm font-medium">{t("engine.polarisAntiCheat")}</p>
                        {state?.kind === "mod" ? (
                            <p className="text-xs text-muted-foreground">
                                {t("engine.onThisNeoforgeServerPolaris")}
                            </p>
                        ) : (
                            <p className="text-xs text-muted-foreground">{t("engine.about")}</p>
                        )}
                    </div>
                    <Switch
                        checked={state?.on ?? false}
                        disabled={
                            !canManage ||
                            pending ||
                            !heard ||
                            state === null ||
                            (!state.on && (!state.supported || !state.reachable))
                        }
                        onChange={(on) => void flip(on)}
                        aria-label={t("engine.polarisAntiCheat")}
                    />
                </div>
                {state && !state.supported ? (
                    <p className="text-xs text-muted-foreground">
                        {t("engine.itRunsOnPaperPurpur")}
                    </p>
                ) : state && !state.reachable && !state.on ? (
                    <p className="text-xs text-muted-foreground">
                        {t("engine.itNeedsThisPolarisTo")}
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
