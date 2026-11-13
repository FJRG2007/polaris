/**
 * Where WhatsApp Web keeps its linked devices: the web's own data volume, so a
 * linked phone survives restarts and updates with nothing to configure.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "@polaris/config";

export function whatsappSessionDir(): string {
    return process.env.WA_SESSION_DIR ?? join(loadEnv().POLARIS_DATA_DIR, "whatsapp-sessions");
}

/** One channel's linked-device keys. The id is a database uuid, kept to the
 *  characters a folder name can safely hold. */
export function whatsappAuthDir(channelId: string): string {
    return join(whatsappSessionDir(), `device-${channelId.replace(/[^A-Za-z0-9-]/g, "")}`);
}

/** Whether a whatsapp-web channel has a linked device on this server. Links made
 *  by the retired messaging bridge lived in its own container and are not here,
 *  so those channels are scanned again. */
export function hasWhatsAppSession(channelId: string): boolean {
    return existsSync(join(whatsappAuthDir(channelId), "creds.json"));
}
