import { call } from "./call";
import { calendar, calendarTime } from "./calendar";
import { chat } from "./chat";
import {
    chatChannelSettings,
    chatDirect,
    chatMedia,
    chatPoll,
    chatPrivacy,
    chatRules,
    chatThread
} from "./chat-more";
import { drive, driveLinks } from "./drive";
import { games } from "./games";
import { callGroup, callMeeting, inCall } from "./in-call";
import { launcher } from "./launcher";
import { mail, mailThread } from "./mail";
import { marketplace, marketplaceInstall } from "./marketplace";
import { office, officeDoc } from "./office";
import { accountSecurity, settings } from "./settings";
import { vault, vaultSends } from "./vault";
import { deploy, deployLogs, deployProject } from "./deploy";
import { taskPanel, tasks } from "./tasks";
import type { SceneDefinition } from "../runtime/scene";

/** Every scene the README shows, in the order the capture takes them. */
export const SCENES: readonly SceneDefinition[] = [
    chat,
    chatThread,
    chatMedia,
    chatPoll,
    chatDirect,
    chatChannelSettings,
    chatRules,
    chatPrivacy,
    tasks,
    taskPanel,
    deploy,
    deployProject,
    deployLogs,
    drive,
    driveLinks,
    mail,
    mailThread,
    calendar,
    calendarTime,
    games,
    office,
    officeDoc,
    vault,
    vaultSends,
    marketplace,
    marketplaceInstall,
    launcher,
    settings,
    accountSecurity,
    call,
    inCall,
    callMeeting,
    callGroup
];
