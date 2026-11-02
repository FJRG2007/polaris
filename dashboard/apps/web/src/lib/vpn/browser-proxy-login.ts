/** The logins of a node's browser proxy. Server only: the node's key signs them, and
 *  a screen importing the rest of the proxy must not pull this into the page. */

import { createHmac, timingSafeEqual } from "node:crypto";
import { PROXY_TOKEN_SECONDS } from "./browser-proxy";

export interface ProxyLogin {
    readonly username: string;
    readonly password: string;
    readonly expiresAt: number;
}

function sign(secret: string, username: string): string {
    return createHmac("sha256", secret).update(username).digest("hex");
}

/** A login for one device, good until `expiresAt` (seconds). */
export function proxyLogin(secret: string, deviceId: string, nowSeconds: number): ProxyLogin {
    const expiresAt = nowSeconds + PROXY_TOKEN_SECONDS;
    const username = `${deviceId}.${expiresAt}`;
    return { username, password: sign(secret, username), expiresAt };
}

/** The same check the node's script makes, kept here so a test can hold them together. */
export function proxyLoginValid(
    secret: string,
    username: string,
    password: string,
    nowSeconds: number
): boolean {
    const expiresAt = Number(username.split(".").at(-1));
    if (!Number.isInteger(expiresAt) || expiresAt < nowSeconds) return false;
    const wanted = Buffer.from(sign(secret, username));
    const given = Buffer.from(password);
    return wanted.length === given.length && timingSafeEqual(wanted, given);
}
