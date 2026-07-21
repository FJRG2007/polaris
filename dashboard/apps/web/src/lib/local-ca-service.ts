/**
 * Local trust anchor for the LAN hostnames the dashboard serves (polaris.local and
 * friends), which cannot get a public certificate because the name never resolves
 * on the internet. On first start Polaris mints a small internal CA and a leaf
 * certificate for those names, hands the leaf to Traefik as its default
 * certificate (via the file provider's dynamic directory), and exposes the CA root
 * for the operator to install once on their devices - after which polaris.local is
 * a normal trusted-HTTPS origin instead of a click-through warning.
 *
 * Everything here is best-effort and non-destructive: if OpenSSL is missing or a
 * step fails, no dynamic TLS file is written and Traefik keeps serving its built-in
 * self-signed default, so the dashboard is never taken offline by this.
 */

import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";

const run = promisify(execFile);

/** Where the CA key/cert and the leaf live durably (survives container restarts). */
function caDir(): string {
    return join(loadEnv().POLARIS_DATA_DIR, "ca");
}

/** The Traefik file-provider directory, shared with the edge container. Both mount
 *  the same volume at this path, so a file written here is readable there verbatim. */
function dynamicDir(): string {
    return process.env.POLARIS_TRAEFIK_DYNAMIC_DIR ?? "/dynamic";
}

const CA_KEY = "ca.key";
const CA_CRT = "ca.crt";
const LEAF_KEY = "leaf.key";
const LEAF_CRT = "leaf.crt";
/** Names Traefik serves the dashboard on, published as the leaf's default cert. */
const DYNAMIC_CRT = "polaris-local.crt";
const DYNAMIC_KEY = "polaris-local.key";
const DYNAMIC_TLS = "polaris-tls.yml";

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/** The DNS + IP names the leaf should be valid for: the mDNS hostname and its
 *  `.local` form, an optional configured public domain, every LAN/internal hostname
 *  Polaris serves (so free sslip.io subdomains and *.plr.local app names are
 *  trusted-HTTPS too, like polaris.local), and every non-internal IPv4 the host has. */
async function subjectAltNames(): Promise<string[]> {
    const host = process.env.POLARIS_MDNS_HOSTNAME || process.env.POLARIS_LOCAL_HOSTNAME || "polaris";
    const dns = new Set<string>([host, `${host}.local`, "polaris", "polaris.local", "plr.local", "*.plr.local", "localhost"]);
    const publicDomain = process.env.POLARIS_PUBLIC_DOMAIN;
    if (publicDomain && publicDomain !== "polaris.internal") dns.add(publicDomain);

    // Every internal-cert domain (free sslip.io LAN subdomains, .plr.local app names)
    // so Traefik's default cert actually matches them instead of throwing a warning.
    try {
        const internal = await prisma.domain.findMany({ where: { certResolver: "internal" }, select: { hostname: true } });
        for (const domain of internal) {
            const hostname = domain.hostname.trim().toLowerCase();
            if (hostname && dns.size < 200) dns.add(hostname);
        }
    } catch {
        // The DB may not be reachable at first-boot CA generation; static names still apply.
    }

    const ips = new Set<string>(["127.0.0.1"]);
    // The host's LAN IP, so access by IP:port is trusted too. Inside the container
    // networkInterfaces() only sees the Docker-internal address, so take the
    // operator-configured public IP (the same one the edge routes on) as well.
    const configuredIp = process.env.POLARIS_PUBLIC_IP;
    if (configuredIp && /^\d{1,3}(\.\d{1,3}){3}$/.test(configuredIp)) ips.add(configuredIp);
    for (const list of Object.values(networkInterfaces())) {
        for (const info of list ?? []) {
            if (info.family === "IPv4" && !info.internal) ips.add(info.address);
        }
    }
    return [
        ...[...dns].map((name) => `DNS:${name}`),
        ...[...ips].map((ip) => `IP:${ip}`)
    ];
}

/** Generate the CA (once) and a leaf for the current names, if not already present.
 *  Returns the paths, or null when OpenSSL is unavailable or generation failed. */
async function ensureCertificates(): Promise<{ leafCrt: string; leafKey: string; caCrt: string } | null> {
    const dir = caDir();
    await mkdir(dir, { recursive: true });
    const caKey = join(dir, CA_KEY);
    const caCrt = join(dir, CA_CRT);
    const leafKey = join(dir, LEAF_KEY);
    const leafCrt = join(dir, LEAF_CRT);

    try {
        if (!(await exists(caCrt)) || !(await exists(caKey))) {
            await run("openssl", [
                "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
                "-keyout", caKey, "-out", caCrt, "-days", "3650",
                "-subj", "/O=Polaris/CN=Polaris Local CA",
                "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
                "-addext", "keyUsage=critical,keyCertSign,cRLSign"
            ]);
        }

        // (Re)issue the leaf when missing or when the SAN set changed (e.g. a new IP
        // or a newly added LAN domain).
        const sanLine = `subjectAltName=${(await subjectAltNames()).join(",")}`;
        const sanMarker = join(dir, "leaf.san");
        const priorSan = (await exists(sanMarker)) ? await readFile(sanMarker, "utf8") : "";
        if (!(await exists(leafCrt)) || !(await exists(leafKey)) || priorSan.trim() !== sanLine) {
            const csr = join(dir, "leaf.csr");
            const ext = join(dir, "leaf.ext");
            await writeFile(
                ext,
                ["basicConstraints=CA:FALSE", "keyUsage=digitalSignature,keyEncipherment", "extendedKeyUsage=serverAuth", sanLine].join("\n"),
                "utf8"
            );
            await run("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", leafKey, "-out", csr, "-subj", "/O=Polaris/CN=polaris.local"]);
            await run("openssl", [
                "x509", "-req", "-in", csr, "-CA", caCrt, "-CAkey", caKey, "-CAcreateserial",
                "-out", leafCrt, "-days", "825", "-sha256", "-extfile", ext
            ]);
            await writeFile(sanMarker, sanLine, "utf8");
        }
        return { leafCrt, leafKey, caCrt };
    } catch (error) {
        console.error("polaris: local CA generation skipped:", error instanceof Error ? error.message : error);
        return null;
    }
}

/**
 * Ensure the local CA + leaf exist and publish the leaf as Traefik's default
 * certificate for the LAN hostnames. Idempotent and best-effort; safe to call on
 * every startup. A failure leaves Traefik's self-signed default in place.
 */
export async function ensureLocalCa(): Promise<void> {
    const certs = await ensureCertificates();
    if (!certs) return;

    const dyn = dynamicDir();
    const crtPath = join(dyn, DYNAMIC_CRT);
    const keyPath = join(dyn, DYNAMIC_KEY);
    try {
        // Serve the full chain (leaf + CA) so a client that trusts the root validates.
        const [leaf, ca, key] = await Promise.all([
            readFile(certs.leafCrt, "utf8"),
            readFile(certs.caCrt, "utf8"),
            readFile(certs.leafKey, "utf8")
        ]);
        await writeFile(crtPath, `${leaf.trimEnd()}\n${ca.trimEnd()}\n`, "utf8");
        await writeFile(keyPath, key, "utf8");
        const tls = [
            "tls:",
            "  stores:",
            "    default:",
            "      defaultCertificate:",
            `        certFile: ${crtPath}`,
            `        keyFile: ${keyPath}`,
            "  certificates:",
            `    - certFile: ${crtPath}`,
            `      keyFile: ${keyPath}`,
            ""
        ].join("\n");
        await writeFile(join(dyn, DYNAMIC_TLS), tls, "utf8");
    } catch (error) {
        console.error("polaris: publishing local TLS default failed:", error instanceof Error ? error.message : error);
    }
}

/** The CA root certificate (PEM) for the operator to install as a trust anchor, or
 *  null when it has not been generated yet. Public material - never the CA key. */
export async function readLocalCaRoot(): Promise<string | null> {
    try {
        return await readFile(join(caDir(), CA_CRT), "utf8");
    } catch {
        return null;
    }
}
