/**
 * US English: the source catalog. Its keys are the ones every other locale must
 * carry, and the types every `t("...")` is checked against.
 *
 * One JSON file per namespace, one line here per file - the catalog test fails
 * when the two disagree.
 */

import nav from "./nav.json";
import chat from "./chat.json";
import common from "./common.json";
import account from "./account.json";

export default { account, chat, common, nav };
