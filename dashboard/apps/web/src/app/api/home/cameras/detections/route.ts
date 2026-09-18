// Places route. The screen lives in the app's own package.
import "@/lib/app-host/server";
export { GET } from "@polaris-app/places/src/routes/api/home/cameras/detections/route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
