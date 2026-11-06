/**
 * The record every sub-page of one person starts from, read once per request.
 *
 * The layout draws the name and the badges from it and each section reads it
 * again for its own controls; `cache` makes those the same query rather than
 * one per caller.
 */

import { cache } from "react";
import { notFound } from "next/navigation";
import { getDirectoryUser, type DirectoryUser } from "@/lib/user-admin-service";

export const loadUserRecord = cache(async (id: string): Promise<DirectoryUser> => {
    const account = await getDirectoryUser(id);
    if (!account) notFound();
    return account;
});
