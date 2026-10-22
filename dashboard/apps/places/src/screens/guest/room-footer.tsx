"use client";

/** Under a room's link: what it is for, until when, or that it holds nothing. */

import { usePlacesT } from "../use-places-t";

export function RoomFooter({
    until,
    note,
    empty
}: {
    until: string | null;
    note: string;
    empty: boolean;
}) {
    const t = usePlacesT();
    return (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            {empty ? <p>{t("guestCamera.roomEmpty")}</p> : null}
            {note ? <p>{note}</p> : null}
            {until ? <p>{t("guest.until", { when: new Date(until).toLocaleString() })}</p> : null}
        </div>
    );
}
