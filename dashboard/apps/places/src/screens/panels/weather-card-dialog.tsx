"use client";

/**
 * A weather card's settings: whose weather it shows - the place's, or a city
 * found by name or this device's location - and whether the next days show
 * under it. Units are the reader's own display preferences, as everywhere.
 */

import { useState } from "react";
import { MapPin } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Switch
} from "@polaris/ui";
import { usePlacesT } from "../use-places-t";
import { LocationSearch } from "../location-search";
import { UseLocationButton } from "../location-button";
import type { WeatherLocation } from "../../lib/panel-layout";

export interface WeatherSettings {
    readonly location: WeatherLocation | null;
    readonly forecast: boolean;
}

export function WeatherCardDialog({
    initial,
    onClose,
    onSave
}: {
    initial: WeatherSettings;
    onClose: () => void;
    onSave: (settings: WeatherSettings) => void;
}) {
    const t = usePlacesT();
    const [location, setLocation] = useState<WeatherLocation | null>(initial.location);
    const [forecast, setForecast] = useState(initial.forecast);
    const unchanged =
        forecast === initial.forecast &&
        location?.name === initial.location?.name &&
        location?.latitude === initial.location?.latitude &&
        location?.longitude === initial.location?.longitude;
    const option = (on: boolean) =>
        `flex min-h-11 min-w-0 flex-1 items-center justify-center rounded-md border px-3 text-sm ${
            on ? "border-primary bg-primary/10 font-medium" : "border-border hover:bg-muted"
        }`;

    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent className="flex max-h-[85dvh] flex-col">
                <DialogHeader>
                    <DialogTitle>{t("weatherCard.title")}</DialogTitle>
                    <DialogDescription>{t("weatherCard.description")}</DialogDescription>
                </DialogHeader>
                <div className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain">
                    <div role="radiogroup" aria-label={t("weatherCard.where")} className="flex gap-2">
                        <button
                            type="button"
                            role="radio"
                            aria-checked={location === null}
                            className={option(location === null)}
                            onClick={() => setLocation(null)}
                        >
                            {t("weatherCard.placeOwn")}
                        </button>
                        <button
                            type="button"
                            role="radio"
                            aria-checked={location !== null}
                            className={option(location !== null)}
                            onClick={() => undefined}
                            aria-disabled={location === null}
                            title={location === null ? t("weatherCard.pickBelow") : undefined}
                        >
                            {t("weatherCard.other")}
                        </button>
                    </div>
                    {location ? (
                        <p className="flex min-w-0 items-center gap-2 rounded-md bg-muted/60 px-3 py-2 text-sm">
                            <MapPin className="size-4 shrink-0 text-muted-foreground" />
                            <span className="truncate" title={location.name}>
                                {t("weatherCard.showing", { name: location.name })}
                            </span>
                        </p>
                    ) : null}
                    <LocationSearch
                        autoFocus
                        onPick={(place) =>
                            setLocation({
                                name: (place.detail
                                    ? `${place.name}, ${place.detail}`
                                    : place.name
                                ).slice(0, 120),
                                latitude: place.latitude,
                                longitude: place.longitude
                            })
                        }
                    />
                    <UseLocationButton
                        onLocated={(found) =>
                            setLocation({
                                name: t("weatherCard.thisDevice"),
                                latitude: found.latitude,
                                longitude: found.longitude
                            })
                        }
                    />
                    <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
                        <span className="min-w-0">{t("weatherCard.forecast")}</span>
                        <Switch
                            checked={forecast}
                            onChange={setForecast}
                            aria-label={t("weatherCard.forecast")}
                        />
                    </label>
                </div>
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={onClose}>
                        {t("panels.cancel")}
                    </Button>
                    <Button
                        type="button"
                        aria-disabled={unchanged}
                        onClick={() => {
                            if (!unchanged) onSave({ location, forecast });
                        }}
                    >
                        {t("panels.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
