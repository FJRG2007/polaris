"use server";

/**
 * What the screen of an installed app whose code is not here can do about it.
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import { retryApp } from "./lifecycle";
import { readerWords } from "@/lib/i18n/reader-words";

const AppId = z.string().regex(/^[a-z0-9-]{1,64}$/);

/** Fetch and load the app's bundle again. */
export async function retryAppAction(id: string): Promise<{ error?: string }> {
    await requireUser();
    const parsed = AppId.safeParse(id);
    if (!parsed.success) return { error: (await readerWords("api"))("refusals.apps.notAnApp") };
    return retryApp(parsed.data);
}
