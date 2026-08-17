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
import { runAction } from "@/lib/run-action";
import { Loader2, Radar } from "lucide-react";
import type { DiscoveredCamera } from "@/lib/home/discovery";
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input } from "@polaris/ui";

export function DiscoverDialog({
    known,
    onClose,
    onPick
}: {
    /** Addresses the house already has, so the list can say so. */
    known: Set<string>;
    onClose: () => void;
    onPick: (found: DiscoveredCamera) => void;
}) {
    const [subnet, setSubnet] = useState("");
    const [busy, setBusy] = useState(false);
    const [found, setFound] = useState<DiscoveredCamera[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const scan = async () => {
        setBusy(true);
        setError(null);
        const result = await runAction(() => actions.discoverCamerasAction({ subnet }), setError);
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
                    <DialogTitle>Look for cameras</DialogTitle>
                    <DialogDescription>
                        Polaris asks the network first. Give it an address range as well if your cameras sit behind a
                        repeater or an access point that blocks that.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex items-end gap-2">
                    <label className="flex flex-1 flex-col gap-1.5">
                        <span className="text-[12px] font-medium text-muted-foreground">Address range</span>
                        <Input
                            value={subnet}
                            onChange={(event) => setSubnet(event.target.value)}
                            placeholder="192.168.1.0/24"
                        />
                    </label>
                    <Button onClick={scan} disabled={busy}>
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <Radar className="size-4 shrink-0" />}
                        Look
                    </Button>
                </div>

                {error ? <p className="mt-3 text-[12px] text-danger">{error}</p> : null}

                {found !== null ? (
                    found.length === 0 ? (
                        <p className="mt-4 text-[13px] text-muted-foreground">
                            Nothing answered. If the camera is on another network, add it by address and choose the
                            server that can see it.
                        </p>
                    ) : (
                        <ul className="mt-4 flex flex-col divide-y divide-border rounded-lg border border-border">
                            {found.map((camera) => (
                                <li key={camera.address} className="flex items-center justify-between gap-3 px-3 py-2">
                                    <div className="min-w-0">
                                        <p className="truncate text-[13px] text-foreground">
                                            {camera.name ?? camera.address}
                                        </p>
                                        <p className="truncate text-[11px] text-foreground-subtle">
                                            {camera.name ? `${camera.address} - ` : ""}
                                            {camera.via === "probe" ? "answered ONVIF" : "has a stream port open"}
                                        </p>
                                    </div>
                                    {known.has(camera.address) ? (
                                        <Badge variant="neutral">Added</Badge>
                                    ) : (
                                        <Button size="sm" variant="secondary" onClick={() => onPick(camera)}>
                                            Add
                                        </Button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )
                ) : null}

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        Close
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
