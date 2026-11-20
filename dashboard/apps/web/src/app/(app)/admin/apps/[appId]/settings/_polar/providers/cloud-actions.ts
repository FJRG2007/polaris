"use server";

/**
 * Cloud accounts on AI providers, for the deployment's own keys: add one from its form, or
 * sign in to DigitalOcean and paste back the address it returned to.
 */

import * as connection from "@/lib/agents/connection-actions";
import type { CloudAddResult } from "@/lib/agents/connection-actions";
import { instanceScope } from "./scope";

export async function addCloudAccountAction(input: unknown): Promise<CloudAddResult> {
    return connection.addCloud(await instanceScope(), input);
}

export async function startDigitaloceanLoginAction(): Promise<{ id: string; url: string }> {
    return connection.startDigitalocean(await instanceScope());
}

export async function finishDigitaloceanLoginAction(input: unknown): Promise<CloudAddResult> {
    return connection.finishDigitalocean(await instanceScope(), input);
}
