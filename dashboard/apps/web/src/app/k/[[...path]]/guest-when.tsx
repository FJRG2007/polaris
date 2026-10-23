"use client";

/**
 * A time on a link's page, in the reader's own zone. The server does not know
 * that zone, so the first paint names UTC and the browser swaps in its own.
 */

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";

const FIELDS: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
};

export function GuestWhen({
    at,
    message
}: {
    at: string;
    message: "guestStatus.checked" | "guestLink.until";
}) {
    const words = useTranslations("publicPages");
    const locale = useLocale();
    const [local, setLocal] = useState(false);
    useEffect(() => setLocal(true), []);
    const when = new Date(at).toLocaleString(
        locale,
        local ? FIELDS : { ...FIELDS, timeZone: "UTC", timeZoneName: "short" }
    );
    return <p>{words(message, { when })}</p>;
}
