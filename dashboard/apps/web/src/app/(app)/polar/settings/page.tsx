/**
 * /polar/settings itself: each section is a page of its own now, so the
 * addresses from before (`?section=`, a connector sign-in's `?connector=`) and
 * the bare one land on the page they meant.
 */

import { redirect } from "next/navigation";
import { legacySettingsTarget } from "@/lib/polar/settings-path";

function one(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

export default async function PolarSettingsIndex({
    searchParams
}: {
    searchParams: Promise<{ connector?: string | string[]; section?: string | string[] }>;
}) {
    const params = await searchParams;
    redirect(legacySettingsTarget({ section: one(params.section), connector: one(params.connector) }));
}
