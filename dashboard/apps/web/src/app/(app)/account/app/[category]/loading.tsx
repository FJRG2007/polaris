"use client";

/**
 * What a category shows the moment it is opened, before the host has answered
 * for the page: the page itself. Nothing on it comes from the server - the
 * headings and rows are the schema's, the values are this computer's - so the
 * route's round trip is no reason to draw a skeleton instead of it.
 */

import { usePathname } from "next/navigation";
import { readAppSettingCategory } from "@polaris/core/app-settings";
import { AppSettingsScreen } from "./app-settings-view";

export default function Loading() {
    const category = readAppSettingCategory(usePathname().split("/").filter(Boolean)[2]);
    return category ? <AppSettingsScreen category={category} /> : null;
}
