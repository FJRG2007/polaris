/**
 * What the browser extension connects through: a small proxy on the node, behind the
 * edge that already holds that server's certificate. A browser refuses a secure proxy
 * with a certificate it does not trust, and offers nobody a way past that.
 *
 * Passwords are signed rather than stored, so the node checks one without asking
 * Polaris and nothing has to be pushed when somebody connects. They last an hour;
 * somebody who loses access simply gets no next one.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const PROXY_PORT = 51821;

/** The machine as any container on it reaches it: Docker's default bridge, which
 *  answers from every network there. Not host.docker.internal, which only a
 *  container started with that mapping can resolve, and an edge set up on a
 *  remote server was not. */
const DOCKER_HOST_GATEWAY = "172.17.0.1";
/** Tor's local entrance for what the proxy sends. Not 9050: that may be the machine's own. */
export const TOR_SOCKS_PORT = 9052;
export const PROXY_TOKEN_SECONDS = 3600;
/** Where the proxy writes what each device has used, for the counters. */
export const PROXY_USAGE_FILE = "/run/polaris-vpn-proxy/usage";
/** Outside the node's private folder: the proxy runs as nobody in particular. */
export const PROXY_SCRIPT = "/usr/local/lib/polaris-vpn-proxy.py";
export const PROXY_KEY = "/etc/polaris-vpn-proxy.key";
export const PROXY_USER = "polaris-vpn-proxy";

export const PROXY_USAGE_READ = `#!/bin/sh
cat ${PROXY_USAGE_FILE} 2>/dev/null
exit 0
`;

/** Each line is a person and what they have used since the proxy started. */
export function parseProxyUsage(output: string): { userId: string; used: bigint }[] {
    return output.split("\n").flatMap((line) => {
        const match = /^([0-9a-f-]{36}) (\d{1,20})$/.exec(line.trim());
        return match?.[1] && match[2] ? [{ userId: match[1], used: BigInt(match[2]) }] : [];
    });
}

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

/** The edge's route: TLS ends there and the bytes go on to the proxy on the machine. */
export function renderProxyEdge(hostname: string): string {
    if (!/^[a-z0-9.-]+$/i.test(hostname)) throw new Error("Not a hostname");
    return [
        "tcp:",
        "  routers:",
        "    polaris-vpn-proxy:",
        `      rule: "HostSNI(\`${hostname}\`)"`,
        "      entryPoints: [websecure]",
        "      priority: 60",
        "      service: polaris-vpn-proxy",
        "      tls:",
        "        certResolver: letsencrypt",
        "  services:",
        "    polaris-vpn-proxy:",
        "      loadBalancer:",
        "        servers:",
        `          - address: "${DOCKER_HOST_GATEWAY}:${PROXY_PORT}"`,
        ""
    ].join("\n");
}

/**
 * The proxy itself. Python because it is already on the systems a node supports and
 * this is short enough to read; there is nothing to download and nothing to keep up
 * to date. It takes CONNECT and plain http, refuses the machine's own networks, and
 * on a Tor node hands every name to Tor unresolved, so no lookup leaves the machine.
 */
export function renderProxyScript(input: { tor: boolean }): string {
    return String.raw`#!/usr/bin/env python3
import asyncio, base64, hashlib, hmac, ipaddress, os, socket, struct, time

SECRET = open("${PROXY_KEY}", "rb").read().strip()
TOR = ${input.tor ? "True" : "False"}
USAGE_FILE = "${PROXY_USAGE_FILE}"
MAX_HEAD = 16384
usage = {}


def login_valid(header):
    try:
        kind, value = header.split(None, 1)
        if kind.lower() != "basic":
            return None
        username, password = base64.b64decode(value, validate=True).decode().split(":", 1)
        device, expires = username.rsplit(".", 1)
        if int(expires) < time.time():
            return None
    except (ValueError, UnicodeDecodeError):
        return None
    wanted = hmac.new(SECRET, username.encode(), hashlib.sha256).hexdigest()
    return device if hmac.compare_digest(wanted, password) else None


async def public_address(host, port):
    loop = asyncio.get_running_loop()
    found = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    for row in found:
        address = ipaddress.ip_address(row[4][0].split("%")[0])
        if address.is_global:
            return row[4][0]
    return None


async def through_tor(host, port):
    reader, writer = await asyncio.open_connection("127.0.0.1", ${TOR_SOCKS_PORT})
    writer.write(b"\x05\x01\x00")
    await writer.drain()
    if await reader.readexactly(2) != b"\x05\x00":
        raise OSError("tor refused")
    name = host.encode()
    writer.write(b"\x05\x01\x00\x03" + bytes([len(name)]) + name + struct.pack("!H", port))
    await writer.drain()
    head = await reader.readexactly(4)
    if head[1] != 0:
        raise OSError("tor could not reach it")
    size = {1: 4, 4: 16}.get(head[3])
    if size is None:
        size = (await reader.readexactly(1))[0]
    await reader.readexactly(size + 2)
    return reader, writer


async def open_target(host, port):
    if TOR:
        return await through_tor(host, port)
    address = await public_address(host, port)
    if address is None:
        raise PermissionError(host)
    return await asyncio.open_connection(address, port)


async def pump(reader, writer, device):
    try:
        while True:
            chunk = await reader.read(65536)
            if not chunk:
                break
            usage[device] = usage.get(device, 0) + len(chunk)
            writer.write(chunk)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


def split_target(value, default):
    if value.startswith("["):
        host, _, rest = value[1:].partition("]")
        return host, int(rest[1:]) if rest.startswith(":") else default
    host, colon, port = value.rpartition(":")
    return (host, int(port)) if colon else (value, default)


async def answer(writer, line):
    writer.write(line.encode() + b"\r\n\r\n")
    await writer.drain()
    writer.close()


async def serve(reader, writer):
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 15)
    except (asyncio.TimeoutError, asyncio.LimitOverrunError, asyncio.IncompleteReadError, ConnectionError):
        writer.close()
        return
    try:
        lines = head.decode("latin-1").split("\r\n")
        method, target, version = lines[0].split(" ", 2)
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                key, value = line.split(":", 1)
                headers[key.strip().lower()] = value.strip()
        device = login_valid(headers.get("proxy-authorization", ""))
        if device is None:
            await answer(writer, 'HTTP/1.1 407 Login Required\r\nProxy-Authenticate: Basic realm="Polaris"\r\nContent-Length: 0')
            return
        if method == "CONNECT":
            host, port = split_target(target, 443)
            remaining = b""
        else:
            if not target.startswith("http://"):
                await answer(writer, "HTTP/1.1 400 Bad Request\r\nContent-Length: 0")
                return
            authority, _, path = target[7:].partition("/")
            host, port = split_target(authority, 80)
            kept = [line for line in lines[1:] if line and not line.lower().startswith(("proxy-", "connection:"))]
            remaining = ("\r\n".join([f"{method} /{path} {version}"] + kept + ["Connection: close", "", ""])).encode("latin-1")
        upstream_reader, upstream_writer = await asyncio.wait_for(open_target(host, port), 30)
    except PermissionError:
        await answer(writer, "HTTP/1.1 403 Forbidden\r\nContent-Length: 0")
        return
    except (OSError, ValueError, asyncio.TimeoutError, asyncio.IncompleteReadError):
        await answer(writer, "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0")
        return
    if method == "CONNECT":
        writer.write(b"HTTP/1.1 200 Connected\r\n\r\n")
        await writer.drain()
    else:
        upstream_writer.write(remaining)
        await upstream_writer.drain()
    await asyncio.gather(pump(reader, upstream_writer, device), pump(upstream_reader, writer, device))


async def report():
    while True:
        await asyncio.sleep(30)
        lines = "".join(f"{device} {used}\n" for device, used in usage.items())
        scratch = USAGE_FILE + ".new"
        with open(scratch, "w") as out:
            out.write(lines)
        os.replace(scratch, USAGE_FILE)


async def main():
    server = await asyncio.start_server(serve, "0.0.0.0", ${PROXY_PORT}, limit=MAX_HEAD)
    async with server:
        await asyncio.gather(server.serve_forever(), report())


asyncio.run(main())
`;
}

export const PROXY_UNIT = `[Unit]
Description=Polaris VPN browser proxy
After=network-online.target polaris-vpn.service
Wants=network-online.target

[Service]
ExecStart=/usr/bin/python3 ${PROXY_SCRIPT}
RuntimeDirectory=polaris-vpn-proxy
Restart=always
RestartSec=3
User=${PROXY_USER}
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
`;
