"use client";

/**
 * Bring players into the event on now from the Events tab, as if each had
 * typed `join`: everybody on the server who is not in it yet, or the ones
 * ticked. Drawn in the shared player form, so it reads like the other player
 * dialogs on this server's screens.
 */

import * as ui from "@polaris/ui";
import { useMemo, useState } from "react";
import { useGameText } from "../game-text";
import { PlayerFormDialog } from "../../components/player-form-dialog";

export type ForceChoice = { who: "everybody" } | { who: "chosen"; players: string[] };

export function ForceJoinDialog({
    online,
    inEvent,
    pending,
    error,
    onClose,
    onConfirm
}: {
    /** Who is on the server, as the last look saw them. */
    online: readonly string[];
    /** Who is in the event already: not offered again. */
    inEvent: readonly string[];
    pending: boolean;
    error: string | null;
    onClose: () => void;
    onConfirm: (choice: ForceChoice) => void;
}) {
    const t = useGameText("minecraft");
    const candidates = useMemo(() => {
        const already = new Set(inEvent.map((name) => name.toLowerCase()));
        return online
            .filter((name) => !already.has(name.toLowerCase()))
            .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
    }, [online, inEvent]);
    const [everybody, setEverybody] = useState(false);
    const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
    // A name ticked before it left the server is not counted or sent.
    const picked = candidates.filter((name) => chosen.has(name));
    const count = everybody ? candidates.length : picked.length;
    const toggle = (name: string) =>
        setChosen((current) => {
            const next = new Set(current);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
        });

    return (
        <PlayerFormDialog
            title={t("events.bringIn")}
            description={t("events.bringInHint")}
            onClose={onClose}
            onConfirm={() =>
                onConfirm(everybody ? { who: "everybody" } : { who: "chosen", players: picked })
            }
            confirmLabel={count > 0 ? t("events.bringConfirm", { count }) : t("events.bringIn")}
            ready={count > 0}
            pending={pending}
            error={error}
        >
            {candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("events.bringNobodyLeft")}</p>
            ) : (
                <>
                    <label className="flex min-w-0 items-center gap-2 text-sm">
                        <ui.Checkbox
                            checked={everybody}
                            disabled={pending}
                            onChange={(event) => setEverybody(event.target.checked)}
                        />
                        <span className="min-w-0 truncate">
                            {t("events.bringEverybody", { count: candidates.length })}
                        </span>
                    </label>
                    <p className="text-xs text-muted-foreground">{t("events.bringChoose")}</p>
                    <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto overscroll-contain">
                        {candidates.map((name) => (
                            <li key={name}>
                                <label className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted/40">
                                    <ui.Checkbox
                                        checked={everybody || chosen.has(name)}
                                        disabled={pending || everybody}
                                        onChange={() => toggle(name)}
                                    />
                                    <span className="min-w-0 truncate" title={name}>
                                        {name}
                                    </span>
                                </label>
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </PlayerFormDialog>
    );
}
