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

import { Select } from "@polaris/ui";
import { useRouter } from "next/navigation";
import { PlaceDialog } from "./place-dialog";
import { choosePlaceAction } from "./actions";
import { useState, useTransition } from "react";
import type { PlaceView } from "@/lib/home/place-kinds";
import { Building2, Factory, House, MapPin, Plus } from "lucide-react";

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
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [adding, setAdding] = useState(false);

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
                aria-label="Which place"
                className="w-56"
                options={
                    canManage
                        ? [...options, { value: "new", label: "Add a place", icon: <Plus className="size-4 shrink-0" /> }]
                        : options
                }
            />
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
