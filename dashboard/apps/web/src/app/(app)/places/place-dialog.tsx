"use client";

/**
 * Naming a place, or renaming one.
 *
 * Three fields, and two of them are optional. A place is a name and a symbol -
 * everything that matters about it is what somebody puts in it - so this asks
 * for as little as it can and gets out of the way.
 *
 * The address is free text and is never turned into a map pin: a stored
 * coordinate for somebody's home is a liability with no use here.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { savePlaceAction } from "./actions";
import { runAction } from "@/lib/run-action";
import { PLACE_KINDS, PLACE_KIND_LABELS, type PlaceKind, type PlaceView } from "@/lib/home/place-kinds";
import {
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

export function PlaceDialog({
    place,
    onClose,
    onSaved
}: {
    place: PlaceView | null;
    onClose: () => void;
    onSaved: (place: PlaceView) => void;
}) {
    const [name, setName] = useState(place?.name ?? "");
    const [kind, setKind] = useState(place?.kind ?? "house");
    const [address, setAddress] = useState(place?.address ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const save = async () => {
        setBusy(true);
        setError(null);
        const result = await runAction(
            () => savePlaceAction(place?.id ?? null, { name, kind, address }),
            setError
        );
        setBusy(false);
        if (!result || result.error || !result.place) {
            if (result?.error) setError(result.error);
            return;
        }
        onSaved(result.place);
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{place ? place.name : "Add a place"}</DialogTitle>
                    <DialogDescription>
                        A house, an office, a workshop - anywhere with cameras of its own.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-[0.75rem] font-medium text-muted-foreground">
                            Name<span className="text-danger"> *</span>
                        </span>
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="The flat"
                            autoFocus
                        />
                    </label>
                    <label className="flex flex-col gap-1.5">
                        <span className="text-[0.75rem] font-medium text-muted-foreground">What it is</span>
                        <Select
                            value={kind}
                            onValueChange={setKind}
                            options={PLACE_KINDS.map((value) => ({
                                value,
                                label: PLACE_KIND_LABELS[value as PlaceKind]
                            }))}
                        />
                    </label>
                    <label className="flex flex-col gap-1.5">
                        <span className="text-[0.75rem] font-medium text-muted-foreground">Where it is</span>
                        <Input
                            value={address}
                            onChange={(event) => setAddress(event.target.value)}
                            placeholder="Optional, and only ever written down"
                        />
                    </label>
                </div>

                {error ? <p className="mt-3 text-[0.75rem] text-danger">{error}</p> : null}

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                    <Button onClick={save} disabled={busy || !name.trim()}>
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        {place ? "Save" : "Add place"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
