/**
 * An installed app's server action, when the app came as a bundle.
 *
 * Next routes its own server actions itself; an app's arrive from the browser
 * half of its bundle (`components/app-bundles/runtime.ts`) and are answered
 * here. Only a function the app's bundle declares as a server action can be
 * reached this way, and each one checks who is calling, as it did when Next ran
 * it. What Next's own actions refuse is refused here too: a request from
 * another origin.
 */

import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { loadedBundle } from "@/lib/app-bundles/loader";
import { runAction } from "@/lib/app-bundles/action-context";
import { fromWire, toWire } from "@/lib/app-bundles/wire";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Next's own limit for a server action's arguments. */
const MAX_BODY_BYTES = 1024 * 1024;

const Call = z.object({
    app: z.string().min(1).max(64),
    module: z.string().min(1).max(200),
    name: z.string().regex(/^[A-Za-z_$][\w$]{0,99}$/),
    args: z.array(z.unknown()).max(64)
});

function refuse(status: number, error: string) {
    return NextResponse.json({ error }, { status });
}

/** The same check Next makes before running one of its own actions. */
function sameOrigin(request: NextRequest): boolean {
    const origin = request.headers.get("origin");
    if (!origin) return false;
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    try {
        return new URL(origin).host === host;
    } catch {
        return false;
    }
}

export async function POST(request: NextRequest) {
    if (!sameOrigin(request)) return refuse(403, "This request did not come from Polaris.");
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES)
        return refuse(413, "That is more than one action can be sent.");
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return refuse(400, "That request could not be read.");
    }
    const parsed = Call.safeParse(body);
    if (!parsed.success) return refuse(400, "That request could not be read.");
    const { app, module, name } = parsed.data;

    const bundle = loadedBundle(app);
    const declared = bundle?.manifest.actions[module];
    const load = bundle?.server.actions[module];
    if (!bundle || !declared?.includes(name) || !load) {
        return refuse(404, "That is not something this app does. Reload the page.");
    }
    let args: unknown[];
    try {
        args = fromWire(parsed.data.args) as unknown[];
    } catch {
        return refuse(400, "That request could not be read.");
    }

    try {
        const action = (await load())[name];
        if (typeof action !== "function")
            return refuse(404, "That is not something this app does. Reload the page.");
        const { value, revalidated } = await runAction(() => Promise.resolve(action(...args)));
        return NextResponse.json({ value: toWire(value), revalidated });
    } catch (error) {
        if (isRedirectError(error))
            return NextResponse.json({ redirect: getURLFromRedirectError(error) });
        // What an action throws names its internals; the browser learns only
        // that it failed, as it does from one of Next's own.
        console.error(`polaris: ${app} action ${module}#${name} failed:`, error);
        return refuse(500, "The server could not do that. Try again.");
    }
}
