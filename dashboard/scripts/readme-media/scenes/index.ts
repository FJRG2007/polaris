import { call } from "./call";
import { calendar } from "./calendar";
import { chat } from "./chat";
import { drive } from "./drive";
import { games } from "./games";
import { inCall } from "./in-call";
import { launcher } from "./launcher";
import { mail, mailThread } from "./mail";
import { marketplace } from "./marketplace";
import { office } from "./office";
import { settings } from "./settings";
import { vault } from "./vault";
import { deploy, deployLogs, deployProject } from "./deploy";
import { taskPanel, tasks } from "./tasks";
import type { SceneDefinition } from "../runtime/scene";

/** Every scene the README shows, in the order the capture takes them. */
export const SCENES: readonly SceneDefinition[] = [chat, tasks, taskPanel, deploy, deployProject, deployLogs, drive, mail, mailThread, calendar, games, office, vault, marketplace, launcher, settings, call, inCall];
