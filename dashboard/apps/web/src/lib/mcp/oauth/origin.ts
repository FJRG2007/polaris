/**
 * The origin a client reached this instance on, which is the issuer and the
 * resource it is told about.
 *
 * One instance answers on several names (polaris.local, its domain), and a
 * client must be told the one it used: the MCP spec has it check that the
 * resource in the metadata is the URL it connected to. The forwarded headers are
 * the caller's to write, which is fine here - a forged name only changes what
 * that same caller is told, and a token minted under one name does not open the
 * endpoint under another.
 */

import { headers } from "next/headers";
import { requestOrigin } from "@/lib/domain-service";

export function originOf(request: Request): string {
    return requestOrigin(request);
}

/** The same, for a page or a server action, which have headers but no Request. */
export async function currentOrigin(): Promise<string> {
    return requestOrigin(new Request("http://localhost/", { headers: await headers() }));
}
