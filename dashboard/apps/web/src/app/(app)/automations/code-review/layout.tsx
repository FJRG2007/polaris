import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** The repository bot's screens draw their words from the agents namespace. */
export default function CodeReviewLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["agents"]}>{children}</Messages>;
}
