/**
 * POST /api/deck/authorize/claim - where a deck's connection request stands, and
 * its key once approved.
 *
 * The CLI's own claim: the row says which kind of key it becomes, so one
 * collector serves both, throttle included.
 */

export { POST } from "@/app/api/cli/authorize/claim/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
