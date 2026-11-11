// Polar's panel names the agent a chat answers as through a server action, and
// loading the real one loads the session and the environment it validates. Every
// screen that renders the panel reaches it, so it answers empty here; a test that
// needs agents mocks it itself.
import { vi } from "vitest";

vi.mock("@/app/(app)/polar/settings/agents-actions", () => ({
    listAgentsAction: async () => ({ ok: true, value: [] }),
    agentNameAction: async () => null,
    saveAgentAction: async () => ({ ok: false, error: "invalid" }),
    deleteAgentAction: async () => ({ ok: true, value: null })
}));
