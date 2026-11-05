// The server picker reads its pages through a server action, and loading the real
// one loads the session and the environment it validates. Installable apps get the
// picker from the client host, so every screen that loads the host reaches it; it
// answers an empty page here, and a test that needs the real action unmocks it.
import { vi } from "vitest";

vi.mock("@/app/(app)/server-options-actions", () => ({
    listServerOptionsAction: async () => ({ items: [], next: null })
}));

vi.mock("@/app/(app)/deploy-target-options-actions", () => ({
    listDeployTargetOptionsAction: async () => ({ items: [], next: null }),
    listServiceOptionsAction: async () => ({ items: [], next: null }),
    templateProjectOptionsAction: async () => ({ items: [], next: null }),
    templateEnvironmentOptionsAction: async () => ({ items: [], next: null })
}));
