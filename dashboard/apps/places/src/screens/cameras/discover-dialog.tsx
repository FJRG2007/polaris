"use client";

/**
 * Finding the cameras that are already on the network.
 *
 * Nobody knows their camera's IP address, and asking for one is where adding a
 * camera usually stops. Polaris asks the network instead: every ONVIF camera on
 * the segment answers a single multicast packet, and a network that swallows
 * multicast - most repeaters do - gets a bounded sweep of the addresses instead.
 *
 * A camera already added is shown as added rather than left out: seeing it in
 * the list is how somebody knows the sweep worked.
 */

import { useState } from "react";
import * as actions from "../actions";
import { Loader2, Radar } from "lucide-react";
import type { DiscoveredCamera } from "../../lib/discovery";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";
import { hostUi } from "@polaris/app-host/client";
import { usePlacesT } from "../use-places-t";

const { runAction } = hostUi.runAction;

export function DiscoverDialog({
    known,
    servers,
    onClose,
    onPick
}: {
    /** Addresses the house already has, so the list can say so. */
    known: Set<string>;
    /** The machines that can be asked to look, for a network Polaris cannot see
     *  itself. */
    servers: { id: string; label: string }[];
    onClose: () => void;
    onPick: (found: DiscoveredCamera) => void;
}) {
    const t = usePlacesT();
    const [subnet, setSubnet] = useState("");
    const [from, setFrom] = useState("");
    const [busy, setBusy] = useState(false);
    const [found, setFound] = useState<DiscoveredCamera[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const scan = async () => {
        setBusy(true);
        setError(null);
        const result = await runAction(
            () => actions.discoverCamerasAction({ subnet, fromServerId: from || null }),
            setError
        );
        setBusy(false);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        setFound(result.found ?? []);
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("cameras.discover")}</DialogTitle>
                    <DialogDescription>
                        {t("discover.intro")}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    <div className="flex items-end gap-2">
                        <label className="flex flex-1 flex-col gap-1.5">
                            <span className="text-[0.75rem] font-medium text-muted-foreground">
                                {t("discover.range")}
                            </span>
                            <Input
                                value={subnet}
                                onChange={(event) => setSubnet(event.target.value)}
                                placeholder="192.168.1.0/24"
                            />
                        </label>
                        <Button onClick={scan} disabled={busy || (Boolean(from) && !subnet.trim())}>
                            {busy ? (
                                <Loader2 className="size-4 shrink-0 animate-spin" />
                            ) : (
                                <Radar className="size-4 shrink-0" />
                            )}
                            {t("discover.look")}
                        </Button>
                    </div>
                    {servers.length > 0 ? (
                        <label className="flex flex-col gap-1.5">
                            <span className="text-[0.75rem] font-medium text-muted-foreground">
                                {t("discover.from")}
                            </span>
                            <Select
                                value={from}
                                onValueChange={setFrom}
                                options={[
                                    { value: "", label: t("dialog.direct") },
                                    ...servers.map((server) => ({
                                        value: server.id,
                                        label: server.label
                                    }))
                                ]}
                            />
                            <span className="text-[0.6875rem] text-foreground-subtle">
                                {t("discover.fromHint")}
                            </span>
                        </label>
                    ) : null}
                </div>

                {error ? <p className="mt-3 text-[0.75rem] text-danger">{error}</p> : null}

                {found !== null ? (
                    found.length === 0 ? (
                        <p className="mt-4 text-[0.8125rem] text-muted-foreground">
                            {t("discover.nothing")}
                        </p>
                    ) : (
                        <ul className="mt-4 flex flex-col divide-y divide-border rounded-lg border border-border">
                            {found.map((camera) => (
                                <li
                                    key={camera.address}
                                    className="flex items-center justify-between gap-3 px-3 py-2"
                                >
                                    <div className="min-w-0">
                                        <p className="truncate text-[0.8125rem] text-foreground">
                                            {camera.name ?? camera.address}
                                        </p>
                                        <p className="truncate text-[0.6875rem] text-foreground-subtle">
                                            {camera.name ? `${camera.address} - ` : ""}
                                            {camera.via === "probe"
                                                ? t("discover.onvif")
                                                : t("discover.port")}
                                        </p>
                                    </div>
                                    {known.has(camera.address) ? (
                                        <Badge variant="neutral">{t("discover.added")}</Badge>
                                    ) : (
                                        <Button
                                            size="sm"
                                            variant="secondary"
                                            onClick={() => onPick(camera)}
                                        >
                                            {t("discover.add")}
                                        </Button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )
                ) : null}

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {t("discover.close")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
