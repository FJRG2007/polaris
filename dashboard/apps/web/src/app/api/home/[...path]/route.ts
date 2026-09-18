// Places's routes. They are the app's own (see lib/app-bundles/serve-route).
import "@/lib/app-host/server";
import { appRouteHandler } from "@/lib/app-bundles/serve-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = appRouteHandler("GET");
export const HEAD = appRouteHandler("HEAD");
export const POST = appRouteHandler("POST");
export const PUT = appRouteHandler("PUT");
export const PATCH = appRouteHandler("PATCH");
export const DELETE = appRouteHandler("DELETE");
export const OPTIONS = appRouteHandler("OPTIONS");
