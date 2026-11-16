import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

import * as catalogue from "@/lib/polar/local-models/catalogue";
import { isPrivateLanHost, lanHostsSchema } from "@/lib/computers/lan-hosts";

const RUNNER = "0193f6a4-7b2c-7d3e-8f4a-5b6c7d8e9f01";

describe("local model ids", () => {
    it("round-trips a model id holding colons and an IPv6 host", () => {
        const ref = { runnerId: RUNNER, server: "ollama" as const, host: "fd12::1", model: "llama3.2:3b" };
        expect(catalogue.readLocalModelId(catalogue.localModelId(ref))).toEqual(ref);
    });

    it("refuses an id that is not one", () => {
        expect(catalogue.readLocalModelId("sonnet")).toBeNull();
        expect(catalogue.readLocalModelId(`${RUNNER}:openai:loopback:gpt`)).toBeNull();
    });
});

describe("localModelsProvider", () => {
    it("lists every served model under one provider, named by computer", () => {
        const provider = catalogue.localModelsProvider(
            [
                {
                    id: RUNNER,
                    name: "Desk",
                    capabilities: {
                        features: ["local-models"],
                        localModels: [{ server: "lmstudio", host: "loopback", models: [{ id: "qwen2.5-7b-instruct" }] }]
                    }
                }
            ],
            "Your computers"
        );
        expect(provider?.provider).toBe(catalogue.LOCAL_MODELS_PROVIDER);
        expect(provider?.models).toHaveLength(1);
        expect(provider?.models[0]?.name).toBe("qwen2.5-7b-instruct - Desk");
        expect(catalogue.readLocalModelId(provider!.models[0]!.model)?.server).toBe("lmstudio");
    });

    it("offers nothing for a runner without the feature", () => {
        const rows = [{ id: RUNNER, name: "Desk", capabilities: { localModels: [{ server: "ollama", host: "loopback", models: [{ id: "m" }] }] } }];
        expect(catalogue.localModelsProvider(rows, "x")).toBeNull();
    });
});

describe("LAN addresses", () => {
    it("accepts private IP literals only, normalized", () => {
        expect(isPrivateLanHost("192.168.1.20")).toBe(true);
        expect(isPrivateLanHost("[FD12::1]")).toBe(true);
        expect(isPrivateLanHost("8.8.8.8")).toBe(false);
        expect(isPrivateLanHost("192.168.1.300")).toBe(false);
        expect(isPrivateLanHost("nas.local")).toBe(false);
        expect(lanHostsSchema.parse([" 10.0.0.5 ", "10.0.0.5"])).toEqual(["10.0.0.5"]);
        expect(lanHostsSchema.safeParse(["203.0.113.9"]).success).toBe(false);
    });
});
