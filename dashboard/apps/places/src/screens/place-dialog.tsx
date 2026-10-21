"use client";

/**
 * Naming a place, or renaming one.
 *
 * Three fields, and two of them are optional. A place is a name and a symbol -
 * everything that matters about it is what somebody puts in it - so this asks
 * for as little as it can and gets out of the way.
 *
 * The address is free text and is never turned into a map pin. The coordinate
 * is separate and optional, for sunrise and sunset: from this browser or typed,
 * and kept to 2 decimals (about a kilometre) here and on the server.
 */

import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { savePlaceAction } from "./actions";
import {
    PLACE_KINDS,
    normalizePlaceLocation,
    placeLocationSchema,
    type PlaceKind,
    type PlaceView
} from "../lib/place-kinds";
import { UseLocationButton } from "./location-button";
import { usePlacesT } from "./use-places-t";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    isDirty,
    Select
} from "@polaris/ui";
import { hostUi } from "@polaris/app-host/client";

const { runAction } = hostUi.runAction;

export function PlaceDialog({
    place,
    onClose,
    onSaved
}: {
    place: PlaceView | null;
    onClose: () => void;
    onSaved: (place: PlaceView) => void;
}) {
    const t = usePlacesT();
    const [name, setName] = useState(place?.name ?? "");
    const [kind, setKind] = useState(place?.kind ?? "house");
    const [address, setAddress] = useState(place?.address ?? "");
    const [latitude, setLatitude] = useState(
        place?.location ? String(place.location.latitude) : ""
    );
    const [longitude, setLongitude] = useState(
        place?.location ? String(place.location.longitude) : ""
    );
    // Checked as it is typed, with the schema the server uses. A field still
    // empty is unfinished rather than wrong, so only a written value is
    // complained about; one of the two alone is said once, under both.
    const location = useMemo(() => {
        const parsed = placeLocationSchema.safeParse(
            normalizePlaceLocation({ latitude, longitude })
        );
        const wrong = (field: "latitude" | "longitude", text: string) =>
            !parsed.success && text.trim() !== ""
                ? parsed.error.issues.find((issue) => issue.path[0] === field)?.message
                : undefined;
        return {
            ok: parsed.success,
            half: (latitude.trim() === "") !== (longitude.trim() === ""),
            latitude: wrong("latitude", latitude),
            longitude: wrong("longitude", longitude)
        };
    }, [latitude, longitude]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const values = { name, kind, address, latitude, longitude };
    // What the dialog opened with: an edit that ends where it started saves nothing.
    const [loaded] = useState(() => values);
    const unchanged = place !== null && !isDirty(loaded, values);

    const save = async () => {
        setBusy(true);
        setError(null);
        const result = await runAction(
            () =>
                savePlaceAction(place?.id ?? null, {
                    name,
                    kind,
                    address,
                    location: { latitude, longitude }
                }),
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
                    <DialogTitle>{place ? place.name : t("placeDialog.addTitle")}</DialogTitle>
                    <DialogDescription>{t("placeDialog.description")}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-[0.75rem] font-medium text-muted-foreground">
                            {t("placeDialog.name")}
                            <span className="text-danger"> *</span>
                        </span>
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={t("placeDialog.namePlaceholder")}
                            autoFocus
                        />
                    </label>
                    <label className="flex flex-col gap-1.5">
                        <span className="text-[0.75rem] font-medium text-muted-foreground">
                            {t("placeDialog.kind")}
                        </span>
                        <Select
                            value={kind}
                            onValueChange={setKind}
                            options={PLACE_KINDS.map((value) => ({
                                value,
                                label: t(`placeKinds.${value as PlaceKind}`)
                            }))}
                        />
                    </label>
                    <label className="flex flex-col gap-1.5">
                        <span className="text-[0.75rem] font-medium text-muted-foreground">
                            {t("placeDialog.address")}
                        </span>
                        <Input
                            value={address}
                            onChange={(event) => setAddress(event.target.value)}
                            placeholder={t("placeDialog.addressPlaceholder")}
                        />
                    </label>
                    <fieldset className="flex min-w-0 flex-col gap-1.5">
                        <legend className="mb-1.5 text-[0.75rem] font-medium text-muted-foreground">
                            {t("placeDialog.location")}
                        </legend>
                        <p className="text-[0.75rem] text-muted-foreground">
                            {t("placeDialog.locationHint")}
                        </p>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <CoordinateField
                                label={t("placeDialog.latitude")}
                                value={latitude}
                                onChange={setLatitude}
                                placeholder="40.42"
                                error={
                                    location.latitude ? t(location.latitude as never) : undefined
                                }
                            />
                            <CoordinateField
                                label={t("placeDialog.longitude")}
                                value={longitude}
                                onChange={setLongitude}
                                placeholder="-3.70"
                                error={
                                    location.longitude ? t(location.longitude as never) : undefined
                                }
                            />
                        </div>
                        {location.half ? (
                            <p className="text-[0.75rem] text-muted-foreground">
                                {t("placeDialog.errors.both")}
                            </p>
                        ) : null}
                        <UseLocationButton
                            disabled={busy}
                            onLocated={(found) => {
                                setLatitude(String(found.latitude));
                                setLongitude(String(found.longitude));
                            }}
                        />
                    </fieldset>
                </div>

                {error ? <p className="mt-3 text-[0.75rem] text-danger">{error}</p> : null}

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={busy}>
                        {t("common.cancel")}
                    </Button>
                    <Button
                        onClick={save}
                        disabled={busy || unchanged || !name.trim() || !location.ok}
                    >
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        {place ? t("common.save") : t("placeDialog.add")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function CoordinateField({
    label,
    value,
    onChange,
    placeholder,
    error
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    error?: string;
}) {
    return (
        <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[0.75rem] text-muted-foreground">{label}</span>
            <Input
                value={value}
                inputMode="decimal"
                placeholder={placeholder}
                aria-invalid={error ? true : undefined}
                onChange={(event) => onChange(event.target.value)}
            />
            {error ? <span className="text-[0.75rem] text-danger">{error}</span> : null}
        </label>
    );
}
