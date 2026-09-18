// Game servers route. The screen lives in the app's own package.
import "@/lib/app-host/server";
export { default } from "@polaris-app/game-servers/src/routes/apps/games/page";
export const dynamic = "force-dynamic";
