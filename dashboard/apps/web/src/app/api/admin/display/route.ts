import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/api-session";
import type { UserDisplayPreferences } from "@polaris/core";
import { getPlatformDisplayPreferences, usersMayChooseTheme } from "@/lib/display-prefs-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the display defaults screen draws, read after its first paint. */
export interface DisplayAdminReading {
    readonly platform: UserDisplayPreferences;
    readonly mayChooseTheme: boolean;
}

/** The deployment's display defaults and whether accounts may pick a theme. */
export async function GET(): Promise<Response> {
    const refused = await apiAdmin();
    if (refused instanceof Response) return refused;
    const [platform, mayChooseTheme] = await Promise.all([
        getPlatformDisplayPreferences(),
        usersMayChooseTheme()
    ]);
    return NextResponse.json({ platform, mayChooseTheme } satisfies DisplayAdminReading);
}
