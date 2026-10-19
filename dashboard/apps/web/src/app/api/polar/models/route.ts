/**
 * GET /api/polar/models - what Polar's picker offers this person: providers
 * they can spend a key on, the catalogue's models for each, and who pays.
 */

import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-session";
import { polarModelOptions } from "@/lib/polar/models";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    return NextResponse.json({ providers: await polarModelOptions(user.id), isAdmin: user.isAdmin });
}
