/**
 * The thing that says who somebody is.
 *
 * There are two ways a house gets one, and the first is the one that should
 * happen: Home installs it, on a machine the owner picks, the way it installs the
 * relay. It is a single container - SCRFD to find faces and ArcFace to tell them
 * apart, the small variants of each, on the CPU - and it is built here rather
 * than borrowed because the well-known alternative is a five-container stack that
 * no button could honestly install.
 *
 * The second is for a house that already runs one. The address and key fields
 * stay, they speak the same dialect, and pointing Home at an existing recognizer
 * keeps working.
 *
 * Where it answers is resolved every time rather than written down. A recognizer
 * on a machine Polaris reaches over SSH is dialled through a tunnel that only
 * exists inside this process, and a stored address for that is an address that is
 * wrong after a restart.
 *
 * What it holds never comes back here. Polaris keeps a name; the photographs and
 * the templates derived from them stay in that container.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { HomeError } from "@/lib/home/home-error";
import { loadEnv } from "@polaris/config";
import { homeInstall } from "@/lib/home/access";
import { installApp } from "@/lib/apps/install-service";
import { installEnvSecret } from "@/lib/apps/install-secret";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { assertServer, findService, serviceUrls } from "@/lib/home/side-service";

/** The catalog app this module installs. */
const RECOGNIZER_APP = "face-recognizer";

/** What the house keeps for itself, on its install row. */
interface HomeSecrets {
    /** An address somebody typed, for a recognizer they run themselves. */
    faceApiUrl?: string;
    faceApiKey?: string;
    /** The install of the one Home put up, when it did. Takes precedence: it is
     *  the one this instance is responsible for. */
    faceInstallId?: string;
}

/** Where a recognizer answers, for each of the two callers.
 *
 *  They are not the same address. Polaris may be reaching it down a tunnel; the
 *  vision worker runs beside it and has to be given the real one. */
export interface RecognizerEndpoint {
    readonly baseUrl: string;
    readonly directUrl: string;
    readonly apiKey: string;
}

async function readSecrets(installedAppId: string): Promise<HomeSecrets> {
    const row = await prisma.installedApp.findFirst({
        where: { id: installedAppId },
        select: { encryptedSecret: true, secretNonce: true, secretKeyId: true }
    });
    if (!row?.encryptedSecret || !row.secretNonce || !row.secretKeyId) return {};
    try {
        return JSON.parse(
            decryptSecret(
                {
                    ciphertext: Buffer.from(row.encryptedSecret),
                    nonce: Buffer.from(row.secretNonce),
                    keyId: row.secretKeyId
                },
                loadEnv().POLARIS_MASTER_KEY
            )
        ) as HomeSecrets;
    } catch {
        return {};
    }
}

async function writeSecrets(installedAppId: string, secrets: HomeSecrets): Promise<void> {
    const blob = encryptSecret(JSON.stringify(secrets), loadEnv().POLARIS_MASTER_KEY);
    await prisma.installedApp.update({
        where: { id: installedAppId },
        data: { encryptedSecret: blob.ciphertext, secretNonce: blob.nonce, secretKeyId: blob.keyId }
    });
}

/**
 * Put a recognizer on a server.
 *
 * Idempotent, and deliberately so: a server that already has one is adopted
 * rather than given a second, because two of them would each hold half the
 * household and neither would recognize everybody.
 *
 * Installing is a deploy, so this belongs behind a button somebody pressed. The
 * container is up long before its models are warm, and it says so on its own
 * health endpoint - this only wires the address.
 */
export async function installRecognizer(ownerId: string, actorId: string, serverId: string): Promise<void> {
    const home = await homeInstall();
    if (!home) throw new HomeError("Home is not installed");
    await assertServer(ownerId, serverId);

    if (!(await findService(RECOGNIZER_APP, serverId))) {
        await installApp(ownerId, actorId, {
            catalogId: RECOGNIZER_APP,
            name: "Face recognition",
            serverId,
            storage: [],
            // Its key is minted by the install. Nobody types it and it is never
            // shown: the only things that call this are Polaris and the workers.
            env: []
        });
    }
    const service = await findService(RECOGNIZER_APP, serverId);
    if (!service) throw new HomeError("The recognizer was installed but cannot be found");

    const current = await readSecrets(home.id);
    // The typed address is left alone rather than cleared. Somebody who had their
    // own recognizer and then installed this one can go back to it by removing
    // this install, and losing the address they had would be a small betrayal.
    await writeSecrets(home.id, { ...current, faceInstallId: service.installedAppId });
}

/**
 * Point the house at a recognizer it runs itself, or unpoint it.
 *
 * A blank address or a blank key clears the pairing, which is how face
 * recognition is switched off without touching anything else - the cameras on
 * that rung fall back to reporting a person and stop asking who.
 *
 * The address is only kept if it parses as an http(s) URL with a host. It is
 * dialled by this server and by every vision worker, so a malformed one is a
 * failure repeated on several machines with no obvious cause.
 */
export async function setFaceRecognition(installedAppId: string, baseUrl: string, apiKey: string): Promise<void> {
    const trimmedUrl = baseUrl.trim().replace(/\/+$/, "");
    if (trimmedUrl) {
        let parsed: URL;
        try {
            parsed = new URL(trimmedUrl);
        } catch {
            throw new HomeError("Write the address as http://192.168.1.20:8000");
        }
        if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) {
            throw new HomeError("Write the address as http://192.168.1.20:8000");
        }
    }
    const current = await readSecrets(installedAppId);
    await writeSecrets(installedAppId, {
        ...current,
        faceApiUrl: trimmedUrl || undefined,
        // An empty key on a save that only changed the address leaves the stored
        // one alone; clearing the address clears the pairing outright.
        faceApiKey: trimmedUrl ? apiKey.trim() || current.faceApiKey : undefined
    });
}

/** The installed recognizer, resolved now. Null when Home never installed one, or
 *  when the one it installed has since been removed. */
async function installedRecognizer(installId: string): Promise<RecognizerEndpoint | null> {
    const row = await prisma.installedApp.findFirst({
        where: { id: installId, status: { not: "removed" }, applicationId: { not: null } },
        select: { applicationId: true, ownerId: true }
    });
    if (!row?.applicationId) return null;
    const [urls, apiKey] = await Promise.all([
        serviceUrls(row.applicationId, row.ownerId),
        installEnvSecret(row.applicationId, row.ownerId, "FACE_API_KEY")
    ]);
    return urls && apiKey ? { ...urls, apiKey } : null;
}

/** Where the recognizer is, whichever kind it is. Null when either half is
 *  missing, which makes the face rung unavailable rather than broken. */
export async function recognizerFor(installedAppId: string): Promise<RecognizerEndpoint | null> {
    const secrets = await readSecrets(installedAppId);
    if (secrets.faceInstallId) {
        const installed = await installedRecognizer(secrets.faceInstallId);
        if (installed) return installed;
    }
    // One that somebody runs themselves is one address for everybody: Polaris and
    // the workers both have to be able to reach it, which is the deal they made
    // by typing it in.
    return secrets.faceApiUrl && secrets.faceApiKey
        ? { baseUrl: secrets.faceApiUrl, directUrl: secrets.faceApiUrl, apiKey: secrets.faceApiKey }
        : null;
}

/** Where the recognizer is, for the house that has one. The people screen and the
 *  assignment builder both need it, and neither should have to know which install
 *  the house is. */
export async function faceEndpoint(): Promise<RecognizerEndpoint | null> {
    const home = await homeInstall();
    return home ? recognizerFor(home.id) : null;
}

/** What the settings screen shows. The key itself never goes back to a browser. */
export interface RecognizerSettings {
    /** An address somebody typed, if they did. */
    readonly baseUrl: string;
    readonly hasKey: boolean;
    /** Whether Home is running one of its own, and where. */
    readonly installedOn: string | null;
    /** Whether it is answering yet - a fresh install spends a minute or two
     *  starting, and "installed but silent" is the state people ask about. */
    readonly answering: boolean;
}

export async function faceRecognitionSettings(installedAppId: string): Promise<RecognizerSettings> {
    const secrets = await readSecrets(installedAppId);
    const endpoint = await recognizerFor(installedAppId);
    return {
        baseUrl: secrets.faceApiUrl ?? "",
        hasKey: Boolean(secrets.faceApiKey),
        installedOn: secrets.faceInstallId ? await serverNameFor(secrets.faceInstallId) : null,
        answering: endpoint ? await answering(endpoint) : false
    };
}

/** Which machine the installed recognizer sits on, in words. Null when the
 *  install has gone, which is also how the screen offers to put one back. */
async function serverNameFor(installId: string): Promise<string | null> {
    const row = await prisma.installedApp.findFirst({
        where: { id: installId, status: { not: "removed" } },
        select: { targetId: true }
    });
    if (!row) return null;
    if (!row.targetId) return "this server";
    const target = await prisma.deployTarget.findFirst({
        where: { id: row.targetId },
        select: { kind: true, name: true, host: { select: { name: true } } }
    });
    if (!target || target.kind === "local") return "this server";
    return target.host?.name ?? target.name ?? "another server";
}

/** Whether it answers at all. Short timeout: this runs while a settings page is
 *  rendering, and a recognizer that is still starting is a fact rather than a
 *  reason to hold the page. */
async function answering(endpoint: RecognizerEndpoint): Promise<boolean> {
    const response = await fetch(`${endpoint.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(2500)
    }).catch(() => null);
    if (!response?.ok) return false;
    const body = (await response.json().catch(() => null)) as { status?: string } | null;
    return body?.status === "ok";
}
