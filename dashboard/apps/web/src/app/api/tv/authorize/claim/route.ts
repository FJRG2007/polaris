/**
 * POST /api/tv/authorize/claim - where a TV's connection request stands, and its
 * key once approved. The CLI's own claim: the row says which kind of key it becomes.
 */

export { POST } from "@/app/api/cli/authorize/claim/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
