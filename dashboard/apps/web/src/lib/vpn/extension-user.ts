/** Who the extension's connection belongs to, the way its other routes ask. */

import { clientHost, clientIp, clientUserAgent } from "@/lib/request-context";
import { bearerToken, readExtensionToken } from "@/lib/extension/sessions";

export async function extensionUser(request: Request): Promise<string | null> {
    const principal = await readExtensionToken(bearerToken(request), {
        ip: (await clientIp()) ?? null,
        userAgent: (await clientUserAgent()) ?? null,
        host: (await clientHost()) ?? null
    });
    return principal?.userId ?? null;
}
