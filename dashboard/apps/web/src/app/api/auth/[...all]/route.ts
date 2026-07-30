/**
 * better-auth catch-all handler. Pinned to the Node runtime because Prisma is not
 * Edge-compatible. All sign-in/up/out/session traffic flows through here.
 */

import { handleAuthRequest } from "@/lib/auth";

export const runtime = "nodejs";

export const GET = handleAuthRequest;
export const POST = handleAuthRequest;
