/**
 * GET /api/polar/models - what Polar's picker offers this person: providers
 * they can spend a key on, the catalogue's models for each, and who pays -
 * plus the title of every tool Polar may use for them, for its cards, and
 * whether they can dictate and talk to it.
 */

import { NextResponse } from "next/server";
import { polarAccessFor, polarCaller } from "@/lib/polar/access";
import { polarTools } from "@/lib/polar/tools";
import { polarModelOptions } from "@/lib/polar/models";
import { polarVoiceAvailability } from "@/lib/polar/voice";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const [providers, toolset, voice, access] = await Promise.all([
        polarModelOptions(user.id),
        polarTools(user),
        polarVoiceAvailability(user.id),
        polarAccessFor(user.id)
    ]);
    // Whether the deployment's keys are this person's to spend, so a picker with
    // nothing in it can say their own key is the way in rather than "ask".
    return NextResponse.json({
        providers,
        tools: toolset.described,
        isAdmin: user.isAdmin,
        voice,
        spendsDeployment: access.spend
    });
}
