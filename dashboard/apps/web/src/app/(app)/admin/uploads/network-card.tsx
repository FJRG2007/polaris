"use client";

/**
 * The storages Polaris reaches at an address on the local network, and who it
 * knows each one to be.
 *
 * A NAS is reached at an address its router lends it, and lends again to
 * somebody else when the lease moves. Polaris follows the device by who it is
 * rather than by that address, and this is where an administrator sees what it
 * knows, makes it look now ("Find it again"), and points a storage at a new
 * address - which is checked by who answers there, because that is where the
 * stored password goes next.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { isLocalAddress } from "@polaris/core";
import { RelativeTime } from "@/components/relative-time";
import { Button, Card, CardBody, Input, cn } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { findStorageAgainAction, setStorageAddressAction } from "./actions";
import type { SearchOutcome, WhereaboutsView } from "@/lib/storage-whereabouts/follow";

/** What the last look found, in a sentence. */
function Outcome({ outcome, onUse, busy }: {
    outcome: SearchOutcome;
    onUse: (address: string) => void;
    busy: boolean;
}) {
    const t = useTranslations("admin");
    switch (outcome.kind) {
        case "answering":
            return <p className="text-xs text-muted-foreground">{t("uploads.network.answering", { address: outcome.address })}</p>;
        case "followed":
            return (
                <p className="text-xs text-muted-foreground">
                    {outcome.mac
                        ? t("uploads.network.followed", { from: outcome.from, to: outcome.to, mac: outcome.mac })
                        : t("uploads.network.followedNoMac", { from: outcome.from, to: outcome.to })}
                </p>
            );
        case "impostor":
            return (
                <p className="text-xs text-danger">
                    {t("uploads.network.impostor", { address: outcome.address, device: outcome.label ?? outcome.address })}
                </p>
            );
        case "gone":
            return <p className="text-xs text-danger">{t("uploads.network.gone", { address: outcome.address })}</p>;
        case "unsupported":
            return <p className="text-xs text-danger">{t("uploads.network.unsupported")}</p>;
        case "candidates":
            return (
                <div className="flex flex-col gap-1.5">
                    <p className="text-xs text-muted-foreground">{t("uploads.network.candidates")}</p>
                    <ul className="flex flex-col gap-1">
                        {outcome.candidates.map((candidate) => (
                            <li key={candidate.address} className="flex min-w-0 items-center justify-between gap-3">
                                <span className="flex min-w-0 flex-col">
                                    <span className="truncate font-mono text-xs" title={candidate.address}>
                                        {candidate.address}
                                    </span>
                                    <span
                                        className="truncate text-xs text-muted-foreground"
                                        title={[candidate.label, candidate.mac].filter(Boolean).join(" - ")}
                                    >
                                        {[candidate.label, candidate.mac].filter(Boolean).join(" - ") ||
                                            t("uploads.network.unnamed")}
                                    </span>
                                </span>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={busy}
                                    onClick={() => onUse(candidate.address)}
                                >
                                    {t("uploads.network.useThis")}
                                </Button>
                            </li>
                        ))}
                    </ul>
                </div>
            );
    }
}

function StorageRow({ initial }: { initial: WhereaboutsView }) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const [view, setView] = useState(initial);
    const [address, setAddress] = useState(initial.address);
    const [searching, setSearching] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);
    /** Who answers at the address being saved, when Polaris cannot prove it is
     *  this storage and is asking whether to use it anyway. */
    const [asking, setAsking] = useState<{ address: string; device: string } | null>(null);

    const typed = address.trim();
    const valid = isLocalAddress(typed);
    const dirty = typed !== view.address;

    const findAgain = async () => {
        setSearching(true);
        setError("");
        setSaved(false);
        const result = await runAction(() => findStorageAgainAction(view.id), setError);
        setSearching(false);
        if (result?.error) setError(result.error);
        if (result?.view) {
            setView(result.view);
            setAddress(result.view.address);
        }
    };

    const save = async (target: string, accept: boolean) => {
        setSaving(true);
        setError("");
        setSaved(false);
        const result = await runAction(
            () => setStorageAddressAction({ id: view.id, address: target, accept }),
            setError
        );
        setSaving(false);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        if (result.confirm) {
            setAsking({ address: target, device: result.confirm.device });
            return;
        }
        setAsking(null);
        if (result.view) {
            setView(result.view);
            setAddress(result.view.address);
            setSaved(true);
        }
    };

    const busy = searching || saving;
    const known = view.remembered;

    return (
        <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
            <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium" title={view.name}>
                        {view.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                        {known ? (
                            <>
                                {known.label && known.mac
                                    ? t("uploads.network.known", { device: known.label, mac: known.mac })
                                    : t("uploads.network.knownAs", { device: known.label ?? known.mac ?? view.name })}{" "}
                                {t("uploads.network.lastSeen")} <RelativeTime iso={known.seenAt} />
                            </>
                        ) : (
                            t("uploads.network.unknown")
                        )}
                    </span>
                </div>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void findAgain()}>
                    {searching && <Loader2 className="size-4 animate-spin" />}
                    {t("uploads.network.findAgain")}
                </Button>
            </div>

            {searching ? (
                <p className="text-xs text-muted-foreground">{t("uploads.network.searching")}</p>
            ) : view.last ? (
                <Outcome outcome={view.last.outcome} busy={busy} onUse={(next) => void save(next, false)} />
            ) : null}

            <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">{t("uploads.network.address")}</span>
                <div className="flex items-start gap-2">
                    <Input
                        className="max-w-48 font-mono"
                        value={address}
                        inputMode="decimal"
                        aria-invalid={typed.length > 0 && !valid}
                        aria-label={t("uploads.network.address")}
                        onChange={(event) => {
                            setAddress(event.target.value);
                            setSaved(false);
                            setAsking(null);
                            setError("");
                        }}
                    />
                    <Button disabled={!dirty || !valid || busy} onClick={() => void save(typed, false)}>
                        {saving && <Loader2 className="size-4 animate-spin" />}
                        {tc("actions.save")}
                    </Button>
                </div>
                {typed.length > 0 && !valid ? (
                    <span className="text-xs text-danger">{t("uploads.network.addressFormat")}</span>
                ) : (
                    <span className="text-xs text-muted-foreground">{t("uploads.network.addressHint")}</span>
                )}
            </label>

            {asking && (
                <div className="flex flex-col gap-2 rounded-md bg-muted/50 p-3">
                    <p className="text-xs">
                        {t("uploads.network.unproven", { device: asking.device, address: asking.address, name: view.name })}
                    </p>
                    <div className="flex gap-2">
                        <Button size="sm" disabled={busy} onClick={() => void save(asking.address, true)}>
                            {saving && <Loader2 className="size-4 animate-spin" />}
                            {t("uploads.network.useIt")}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsking(null)}>
                            {tc("actions.cancel")}
                        </Button>
                    </div>
                </div>
            )}

            {error && <p className={cn("text-xs text-danger")}>{error}</p>}
            {saved && !error && <p className="text-xs text-muted-foreground">{t("uploads.saved")}</p>}
        </li>
    );
}

export function NetworkStorageCard({ storages }: { storages: WhereaboutsView[] }) {
    const t = useTranslations("admin");
    return (
        <Card>
            <CardBody className="flex flex-col gap-4 p-4">
                <div>
                    <h2 className="text-sm font-medium">{t("uploads.network.title")}</h2>
                    <p className="text-xs text-muted-foreground">{t("uploads.network.intro")}</p>
                </div>
                <ul className="flex flex-col divide-y divide-border">
                    {storages.map((storage) => (
                        <StorageRow key={storage.id} initial={storage} />
                    ))}
                </ul>
            </CardBody>
        </Card>
    );
}
