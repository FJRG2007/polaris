// Game servers route. The screen lives in the app's own package.
import "@/lib/app-host/server";
export { POST } from "@polaris-app/game-servers/src/routes/api/minecraft/login/[id]/[action]/route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
