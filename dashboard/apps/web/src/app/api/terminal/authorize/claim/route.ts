/**
 * POST /api/terminal/authorize/claim - where a terminal's sign-in request
 * stands, and its key once approved.
 *
 * The CLI's own claim: the row says which kind of key it becomes, so one
 * collector serves every kind, throttle included.
 */

export { POST } from "@/app/api/cli/authorize/claim/route";
