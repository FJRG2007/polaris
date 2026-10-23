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
import { gameConsole, gameEvents, gameInventory, gamePlayers } from "./game-server";
import { callDirect, callGroup, callMeeting, inCall } from "./in-call";
import { launcher } from "./launcher";
import { mail, mailThread } from "./mail";
import { marketplace, marketplaceInstall } from "./marketplace";
import { office, officeDoc } from "./office";
import { placesOverview } from "./places";
import { accountSecurity, settings, settingsRoles, settingsUsers } from "./settings";
import { soundboard } from "./soundboard";
import { vault, vaultSends } from "./vault";
import { deploy, deployLogs, deployProject } from "./deploy";
import { taskPanel, tasks } from "./tasks";
import { notes } from "./notes";
import { polar } from "./polar";
import { watch } from "./watch";
import { automations } from "./automations";
import { tools } from "./tools";
import { statusPages } from "./status-pages";
import { mailServer } from "./mail-server";
import { cloudServers } from "./cloud-servers";
import { securityScans } from "./security-scans";
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
    gamePlayers,
    gameInventory,
    gameEvents,
    gameConsole,
    office,
    officeDoc,
    vault,
    vaultSends,
    notes,
    polar,
    automations,
    watch,
    placesOverview,
    tools,
    statusPages,
    mailServer,
    cloudServers,
    securityScans,
    marketplace,
    marketplaceInstall,
    launcher,
    settings,
    settingsRoles,
    settingsUsers,
    accountSecurity,
    call,
    inCall,
    callMeeting,
    callGroup,
    callDirect,
    soundboard
];
