// Game servers route. The screen lives in the app's own package.
import "@/lib/app-host/server";
export { GET } from "@polaris-app/game-servers/src/routes/api/apps/installed/[id]/minecraft/items/icon/route";
export const runtime = "nodejs";
