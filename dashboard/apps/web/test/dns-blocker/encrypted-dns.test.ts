/**
 * Encrypted DNS as the service deploys it: an engine only names certificate
 * files that are already on its volume, never takes a port or a hostname that
 * is somebody else's, picks a renewed certificate up on its own, and leaves no
 * old key behind.
 */

import * as dns from "@/lib/dns-blocker/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeBlockyConfig } from "@/lib/dns-blocker/render";
import { engineTlsFor, servedTlsFiles } from "@/lib/dns-blocker/dot";

type Certificate = { base: string; certPem: string; keyPem: string };

const OLD: Certificate = { base: "plr.example.com", certPem: "CERT-OLD", keyPem: "KEY-OLD" };
const NEW: Certificate = { base: "plr.example.com", certPem: "CERT-NEW", keyPem: "KEY-NEW" };
const ADDRESS = "192.0.2.10";
const ON = { ...dns.DEFAULT_DNS_SETTINGS, encryptedDns: true };

const calls: string[] = [];
const state: {
    config: string | null;
    engine: "running" | "failed" | null;
    deployed: string | null;
    deploys: string[];
    source: string;
    certificate: Certificate | null;
    nameTaken: boolean;
    dotAnswers: boolean;
    probed: number[];
    pruned: string[][];
} = {
    config: null,
    engine: "running",
    deployed: null,
    deploys: [],
    source: "{}",
    certificate: null,
    nameTaken: false,
    dotAnswers: false,
    probed: [],
    pruned: []
};

const writeFile = vi.fn(async (_container: string, path: string) => {
    calls.push(`write ${path}`);
});
const runIn = vi.fn(async (_container: string, argv: readonly string[]) => {
    state.pruned.push([...argv]);
    calls.push("prune");
    return { code: 0, output: "" };
});

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: async ({ where }: { where: { catalogId: string } }) =>
                where.catalogId === "dns-blocker"
                    ? { id: "app", config: state.config }
                    : state.engine
                      ? {
                            id: "engine",
                            ownerId: "owner",
                            applicationId: "application",
                            status: state.engine
                        }
                      : null,
            update: async ({ data }: { data: { status: "running" | "failed" } }) => {
                state.engine = data.status;
                return {};
            }
        },
        envVar: {
            findFirst: async () => (state.deployed === null ? null : { value: state.deployed })
        },
        application: {
            findUnique: async () => ({ sourceConfig: state.source, target: {} }),
            update: async ({ data }: { data: { sourceConfig: string } }) => {
                state.source = data.sourceConfig;
                return {};
            }
        },
        volume: { findFirst: async () => ({ id: "volume" }) },
        deployment: { findFirst: async () => null }
    }
}));
vi.mock("@/lib/apps/install-config", () => ({
    readInstallConfig: (raw: string | null | undefined) => (raw ? JSON.parse(raw) : {}),
    patchInstallConfig: async (_id: string, patch: Record<string, unknown>) => {
        const current = state.config ? JSON.parse(state.config) : {};
        state.config = JSON.stringify({ ...current, ...patch });
    }
}));
vi.mock("@/lib/deploy-service", () => ({
    deployApplication: async () => {
        // A deploy that names files the volume does not have would not start.
        const served = servedTlsFiles(state.deployed);
        if (served && !calls.includes(`write ${served.certFile}`)) throw new Error("no cert file");
        state.deploys.push(state.deployed ?? "");
        calls.push(served ? "deploy tls" : "deploy");
    }
}));
vi.mock("@/lib/env-var-service", () => ({
    setEnvVar: async (_scope: string, _id: string, _owner: string, input: { value: string }) => {
        state.deployed = input.value;
    }
}));
vi.mock("@/lib/host-address", () => ({
    getHostLanIp: async () => ADDRESS,
    getHostLanIps: async () => [ADDRESS]
}));
vi.mock("@/lib/dns-blocker/probe", () => ({
    probeDns: async () => ({ kind: "silent" }),
    tcpListening: async (_address: string, _timeout: number, port = 53) => {
        state.probed.push(port);
        return port === 853 ? state.dotAnswers : false;
    },
    answerBlocks: () => false
}));
vi.mock("@/lib/deploy-volume-service", () => ({ createVolume: async () => undefined }));
vi.mock("@/lib/apps/install-service", () => ({
    installApp: async () => {
        state.engine = "running";
        calls.push("install");
        return { installedAppId: "engine" };
    },
    uninstallApp: vi.fn()
}));
vi.mock("@/lib/dns-blocker/insights", () => ({
    engineTarget: async () => ({ container: "engine-1", ports: { writeFile, runIn } }),
    refreshLists: async () => undefined
}));
vi.mock("@/lib/wildcard-cert-service", () => ({
    wildcardCertificate: async () => state.certificate
}));
vi.mock("@/lib/app-edge", () => ({ edgeHostnameTaken: async () => state.nameTaken }));

const service = await import("@/lib/dns-blocker/service");
const files = await import("@/lib/dns-blocker/engine-files");

const tlsOf = (certificate: Certificate) => engineTlsFor(certificate, ADDRESS);
const engineRow = (status: "running" | "failed") => ({
    id: "engine",
    ownerId: "owner",
    applicationId: "application",
    status
});
const publishing = JSON.stringify({ hostIp: ADDRESS, extraPorts: [{ container: 853 }] });

beforeEach(() => {
    calls.length = 0;
    Object.assign(state, {
        config: JSON.stringify({ dns: dns.DEFAULT_DNS_SETTINGS }),
        engine: "running",
        deployed: encodeBlockyConfig(dns.DEFAULT_DNS_SETTINGS),
        deploys: [],
        source: "{}",
        certificate: NEW,
        nameTaken: false,
        dotAnswers: false,
        probed: [],
        pruned: []
    });
    writeFile.mockClear();
    runIn.mockClear();
    files.forgetEngineFiles();
});

describe("switching encrypted DNS on", () => {
    it("writes the certificate before the one deploy that names it", async () => {
        await service.saveSettings(ON, "admin");
        expect(state.deploys).toHaveLength(1);
        expect(servedTlsFiles(state.deployed)).toEqual({
            certFile: tlsOf(NEW).certFile,
            keyFile: tlsOf(NEW).keyFile
        });
        expect(calls.indexOf(`write ${tlsOf(NEW).keyFile}`)).toBeLessThan(
            calls.indexOf("deploy tls")
        );
        expect(JSON.parse(state.source).extraPorts).toEqual(
            expect.arrayContaining([expect.objectContaining({ container: 853 })])
        );
    });

    it("deploys a stopped engine once without it first, then with it", async () => {
        state.engine = "failed";
        await service.saveSettings(ON, "admin");
        expect(calls.filter((call) => call.startsWith("deploy"))).toEqual(["deploy", "deploy tls"]);
        expect(servedTlsFiles(state.deployed)?.certFile).toBe(tlsOf(NEW).certFile);
    });

    it("adds it to a freshly installed engine once its files are there", async () => {
        state.engine = null;
        state.deployed = null;
        state.config = JSON.stringify({ dns: ON });
        await service.turnOn("admin");
        expect(calls[0]).toBe("install");
        expect(calls.filter((call) => call.startsWith("deploy"))).toEqual(["deploy tls"]);
    });

    it("leaves port 853 alone when something else already answers on it", async () => {
        state.dotAnswers = true;
        await service.saveSettings(ON, "admin");
        expect(servedTlsFiles(state.deployed)).toBeNull();
        expect(JSON.stringify(JSON.parse(state.source).extraPorts ?? [])).not.toContain("853");
    });

    it("never takes a hostname a deployed app or the dashboard answers for", async () => {
        state.nameTaken = true;
        await service.saveSettings(ON, "admin");
        expect(servedTlsFiles(state.deployed)).toBeNull();
        expect(calls).not.toContain(`write ${tlsOf(NEW).keyFile}`);
    });
});

describe("the status of encrypted DNS", () => {
    it("names the blocker when there is no certificate", async () => {
        state.certificate = null;
        const status = await service.encryptedDnsStatus(ON, ADDRESS, engineRow("running"));
        expect(status).toMatchObject({
            hostname: null,
            blocker: "noCertificate",
            listening: false
        });
    });

    it("names the blocker when there is no address", async () => {
        const status = await service.encryptedDnsStatus(ON, null, engineRow("running"));
        expect(status.blocker).toBe("noAddress");
    });

    it("names the blocker when the hostname is taken", async () => {
        state.nameTaken = true;
        const status = await service.encryptedDnsStatus(ON, ADDRESS, engineRow("running"));
        expect(status).toMatchObject({ hostname: "dns.plr.example.com", blocker: "nameTaken" });
    });

    it("says the port is taken when 853 answers and the filter does not publish it", async () => {
        state.dotAnswers = true;
        const status = await service.encryptedDnsStatus(ON, ADDRESS, engineRow("running"));
        expect(status.blocker).toBe("portTaken");
    });

    it("asks nothing on port 853 while it is off and not published", async () => {
        const status = await service.encryptedDnsStatus(
            dns.DEFAULT_DNS_SETTINGS,
            ADDRESS,
            engineRow("running")
        );
        expect(status).toMatchObject({ enabled: false, blocker: null, listening: false });
        expect(state.probed).not.toContain(853);
    });

    it("listens only while the engine was given the certificate there is now", async () => {
        state.source = publishing;
        state.dotAnswers = true;
        state.deployed = encodeBlockyConfig(ON, undefined, tlsOf(NEW));
        expect(
            (await service.encryptedDnsStatus(ON, ADDRESS, engineRow("running"))).listening
        ).toBe(true);
        state.deployed = encodeBlockyConfig(ON, undefined, tlsOf(OLD));
        expect(
            (await service.encryptedDnsStatus(ON, ADDRESS, engineRow("running"))).listening
        ).toBe(false);
    });
});

describe("a renewed certificate", () => {
    it("is applied by the periodic pass, written before the deploy that names it", async () => {
        state.config = JSON.stringify({ dns: ON });
        state.source = publishing;
        state.dotAnswers = true;
        state.deployed = encodeBlockyConfig(ON, new Date(), tlsOf(OLD));
        calls.push(`write ${tlsOf(OLD).certFile}`);
        expect(await service.reapplyAfterClockChange()).toEqual({ applied: true });
        expect(servedTlsFiles(state.deployed)?.certFile).toBe(tlsOf(NEW).certFile);
        expect(calls.indexOf(`write ${tlsOf(NEW).certFile}`)).toBeLessThan(
            calls.indexOf("deploy tls")
        );
    });

    it("is not a reason to apply anything else that changed", async () => {
        state.config = JSON.stringify({ dns: { ...ON, logDays: ON.logDays + 1 } });
        state.source = publishing;
        state.deployed = encodeBlockyConfig(ON, new Date(), tlsOf(OLD));
        expect(await service.reapplyAfterClockChange()).toEqual({ applied: false });
        expect(state.deploys).toHaveLength(0);
    });

    it("leaves a current engine alone", async () => {
        state.config = JSON.stringify({ dns: ON });
        state.source = publishing;
        state.deployed = encodeBlockyConfig(ON, new Date(), tlsOf(NEW));
        expect(await service.reapplyAfterClockChange()).toEqual({ applied: false });
    });
});

describe("old certificates on the engine's volume", () => {
    it("keeps the pair it serves and the pair the running engine names, and nothing else", async () => {
        state.config = JSON.stringify({ dns: ON });
        state.source = publishing;
        state.deployed = encodeBlockyConfig(ON, new Date(), tlsOf(OLD));
        await service.reapplyAfterClockChange();
        const kept = (argv: string[]) =>
            argv.flatMap((arg, at) => (argv[at - 1] === "-path" ? [arg] : []));
        expect(kept(state.pruned[0] ?? [])).toEqual(
            [
                tlsOf(OLD).certFile,
                tlsOf(OLD).keyFile,
                tlsOf(NEW).certFile,
                tlsOf(NEW).keyFile
            ].sort()
        );
        // Once the new one is deployed, the old pair goes.
        expect(kept(state.pruned.at(-1) ?? [])).toEqual(
            [tlsOf(NEW).certFile, tlsOf(NEW).keyFile].sort()
        );
    });

    it("removes every one when encrypted DNS is switched off", async () => {
        state.config = JSON.stringify({ dns: ON });
        state.source = publishing;
        state.deployed = encodeBlockyConfig(ON, undefined, tlsOf(NEW));
        calls.push(`write ${tlsOf(NEW).certFile}`);
        await service.saveSettings(dns.DEFAULT_DNS_SETTINGS, "admin");
        const last = state.pruned.at(-1) ?? [];
        expect(last).not.toContain("-path");
        expect(last.slice(0, 2)).toEqual(["find", "/logs"]);
        expect(last).toEqual(expect.arrayContaining(["-name", "dot-*", "rm"]));
    });

    it("is not asked again while the set it keeps is the same", async () => {
        await service.saveSettings({ ...dns.DEFAULT_DNS_SETTINGS, deny: ["a.example"] }, "admin");
        await service.saveSettings({ ...dns.DEFAULT_DNS_SETTINGS, deny: ["b.example"] }, "admin");
        expect(runIn).toHaveBeenCalledTimes(1);
    });
});
