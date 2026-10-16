// @vitest-environment jsdom

/**
 * A service's GPU switch: offered only where its server has a card, never on a
 * swarm cluster, always allowed off, and read-only for someone who cannot change
 * how the service runs. Rendered with the real catalogs; the server reads and
 * the save are stand-ins.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/app/(app)/apps/deploy/gpu-actions", () => ({
    serviceGpuAction: vi.fn(),
    saveServiceGpuAction: vi.fn()
}));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/deploy-service", () => ({ restartFromKeptImage: vi.fn() }));

import { MessagesWrapper } from "../setup/i18n";
import { LOCAL_HOST_SUBJECT } from "@/lib/metrics-shared";
import { GpuCardBody } from "@/app/(app)/apps/deploy/gpu-card";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { gpuRefusal, machineSubjectOf, type ServiceGpuView } from "@/lib/deploy/gpu-service";

afterEach(cleanup);

const WITH_CARD: ServiceGpuView = {
    enabled: false,
    refusal: null,
    cards: [{ index: 0, name: "NVIDIA A2", memoryTotalBytes: 16 * 1024 ** 3 }],
    memoryUsedBytes: null
};
const NO_CARD: ServiceGpuView = { enabled: false, refusal: "noGpu", cards: [], memoryUsedBytes: null };

function Card({
    view,
    canConfigure = true,
    onToggle = () => {}
}: {
    view: ServiceGpuView;
    canConfigure?: boolean;
    onToggle?: (enabled: boolean) => void;
}) {
    const t = useTranslations("deployService");
    return <GpuCardBody view={view} canConfigure={canConfigure} pending={false} note={null} onToggle={onToggle} t={t} />;
}

function show(props: Parameters<typeof Card>[0]) {
    render(<Card {...props} />, { wrapper: MessagesWrapper });
    return screen.getByRole("switch", { name: "Use the GPU" });
}

describe("whether a service may be given a card", () => {
    it("is refused on a machine without one and on a swarm cluster", () => {
        const local = { kind: "local", hostId: null, runtime: "compose" };
        expect(gpuRefusal(local, true)).toBeNull();
        expect(gpuRefusal(local, false)).toBe("noGpu");
        expect(gpuRefusal({ kind: "remote", hostId: "h1", runtime: "swarm" }, true)).toBe("swarm");
    });

    it("looks up the machine the service runs on", () => {
        expect(machineSubjectOf({ kind: "local", hostId: null, runtime: "compose" })).toBe(LOCAL_HOST_SUBJECT);
        expect(machineSubjectOf({ kind: "remote", hostId: "h1", runtime: "compose" })).toBe("h1");
    });
});

describe("the GPU card", () => {
    it("offers the switch where the server has a card, naming the cards", () => {
        const onToggle = vi.fn();
        const toggle = show({ view: WITH_CARD, onToggle });
        expect(toggle.hasAttribute("disabled")).toBe(false);
        expect(screen.getByText("Cards on its server: 0: NVIDIA A2")).toBeTruthy();
        fireEvent.click(toggle);
        expect(onToggle).toHaveBeenCalledWith(true);
    });

    it("keeps it off and says why where the server has no card", () => {
        const toggle = show({ view: NO_CARD });
        expect(toggle.hasAttribute("disabled")).toBe(true);
        expect(screen.getByText(/Its server has no NVIDIA card Polaris can see/)).toBeTruthy();
    });

    it("still lets a service that has it turn it off, wherever it now runs", () => {
        const onToggle = vi.fn();
        const toggle = show({ view: { ...NO_CARD, enabled: true }, onToggle });
        expect(toggle.hasAttribute("disabled")).toBe(false);
        expect(screen.getByText("Not holding any GPU memory right now.")).toBeTruthy();
        fireEvent.click(toggle);
        expect(onToggle).toHaveBeenCalledWith(false);
    });

    it("shows what the service holds on the cards", () => {
        show({ view: { ...WITH_CARD, enabled: true, memoryUsedBytes: 2 * 1024 ** 3 } });
        expect(screen.getByText(/^Using .+ of GPU memory\.$/)).toBeTruthy();
    });

    it("is read-only for someone who cannot change how the service runs", () => {
        const toggle = show({ view: WITH_CARD, canConfigure: false });
        expect(toggle.hasAttribute("disabled")).toBe(true);
        expect(screen.getByText("You cannot change how this service runs.")).toBeTruthy();
    });
});
