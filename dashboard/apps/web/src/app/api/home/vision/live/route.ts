// Places route. The screen lives in the app's own package.
import "@/lib/app-host/server";
export { POST } from "@polaris-app/places/src/routes/api/home/vision/live/route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
