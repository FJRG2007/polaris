"use client";

/** Said once, above the booking screens, while the operator has booking pages
 *  switched off for this Polaris. */

import Link from "next/link";
import { useCalendarT } from "../i18n";
import { StatusNote } from "../public/kit";

export function BookingOffNote({ canManage }: { canManage: boolean }) {
    const t = useCalendarT();
    return (
        <StatusNote tone="warning">
            {t("bookingPage.switchedOff")}{" "}
            {canManage ? (
                <Link href="/calendar/admin" className="underline underline-offset-2">
                    {t("bookingPage.switchOn")}
                </Link>
            ) : null}
        </StatusNote>
    );
}
