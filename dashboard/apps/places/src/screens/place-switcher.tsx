"use client";

/**
 * Which place you are looking at.
 *
 * Every screen in this app is about one of them, so the choice sits at the top
 * of all of them rather than being a filter each screen offers separately. It is
 * the same shape as picking a project in Deploy, and for the same reason:
 * choosing once and having the whole app follow beats choosing again on every
 * screen.
 *
 * The choice is written as a cookie by the server action and the page is
 * refreshed, rather than filtering in the browser: the wall, what happened and
 * what was kept are all resolved on the server, and a client-side filter would
 * mean fetching another building's cameras in order not to show them.
 */

import { Button, Select } from "@polaris/ui";
import { hostUi } from "@polaris/app-host/client";
import { useRouter } from "next/navigation";
import { PlaceDialog } from "./place-dialog";
import { usePlacesT } from "./use-places-t";
import { choosePlaceAction } from "./actions";
import { useState, useTransition } from "react";
import type { PlaceView } from "../lib/place-kinds";
import { Building2, Factory, House, MapPin, Plus, Share2 } from "lucide-react";

const { ShareDialog } = hostUi.accessShareDialog;

/** The symbol beside each kind. Only ever decoration - nothing behaves
 *  differently - but "Warehouse" and "Mum's" read better with the right one. */
const KIND_ICON: Record<string, typeof House> = {
    house: House,
    office: Building2,
    site: Factory,
    other: MapPin
};

export function PlaceSwitcher({
    places,
    current,
    canManage
}: {
    places: readonly PlaceView[];
    current: PlaceView;
    canManage: boolean;
}) {
    const t = usePlacesT();
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [adding, setAdding] = useState(false);
    const [sharing, setSharing] = useState(false);

    const choose = (id: string) => {
        if (id === "new") {
            setAdding(true);
            return;
        }
        startTransition(async () => {
            await choosePlaceAction(id);
            router.refresh();
        });
    };

    const options = places.map((place) => {
        const Icon = KIND_ICON[place.kind] ?? MapPin;
        return {
            value: place.id,
            label: place.name,
            icon: <Icon className="size-4 shrink-0" />
        };
    });

    return (
        <>
            <Select
                value={current.id}
                onValueChange={choose}
                disabled={pending}
                aria-label={t("switcher.label")}
                className="w-56"
                options={
                    canManage
                        ? [
                              ...options,
                              {
                                  value: "new",
                                  label: t("switcher.add"),
                                  icon: <Plus className="size-4 shrink-0" />
                              }
                          ]
                        : options
                }
            />
            {canManage ? (
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("switcher.share", { name: current.name })}
                    title={t("switcher.share", { name: current.name })}
                    onClick={() => setSharing(true)}
                >
                    <Share2 className="size-4 shrink-0" />
                </Button>
            ) : null}
            {sharing ? (
                <ShareDialog
                    open
                    onOpenChange={(next: boolean) => (next ? undefined : setSharing(false))}
                    subject="place.place"
                    subjectId={current.id}
                    name={current.name}
                    // The whole building as one key: dates, check-in and
                    // check-out, hours and uses, as for a room.
                    bounded
                />
            ) : null}
            {adding ? (
                <PlaceDialog
                    place={null}
                    onClose={() => setAdding(false)}
                    onSaved={(place) => {
                        setAdding(false);
                        // Land in what was just made: somebody adding a place is
                        // about to put a camera in it.
                        choose(place.id);
                    }}
                />
            ) : null}
        </>
    );
}
