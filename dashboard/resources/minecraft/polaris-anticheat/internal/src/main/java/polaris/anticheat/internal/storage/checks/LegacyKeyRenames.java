package polaris.anticheat.internal.storage.checks;

import org.jetbrains.annotations.ApiStatus;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Canonical {@code polarisac.legacy.* → polarisac.<category>.<descriptive>} rename map.
 * Consumed by:
 *
 * <ul>
 *   <li>{@link StableKeyMapping} when assigning stable_keys during V0→V1 migration.</li>
 *   <li>Each backend's schema migration step that runs an
 *       {@code UPDATE polarisac_checks SET stable_key = ? WHERE stable_key = ?} pass
 *       to rewrite already-persisted rows on existing operator installs.</li>
 * </ul>
 *
 * <p>Order matters only for readability — every entry's old key is unique and
 * the migration applies them all idempotently. Entries omitted here keep their
 * {@code polarisac.legacy.*} key forever (V0-only historical checks with no live V2
 * class — aim-fold/gold/hold, looka, clientbrand — stay legacy because there
 * is no source-of-truth class to rename).
 */
@ApiStatus.Internal
public final class LegacyKeyRenames {

    private LegacyKeyRenames() {}

    public static final Map<String, String> OLD_TO_NEW;

    static {
        Map<String, String> m = new LinkedHashMap<>();

        // BadPackets — letter-keyed checks where V2 and V3 diverged in semantics.
        m.put("polarisac.legacy.badpacketsb", "polarisac.badpackets.ignored_rotation");
        m.put("polarisac.legacy.badpacketsc", "polarisac.badpackets.wake_not_sleeping");
        m.put("polarisac.legacy.badpacketsh", "polarisac.badpackets.unexpected_sequence");
        m.put("polarisac.legacy.badpacketsj", "polarisac.badpackets.use_item_rotation_mismatch");
        m.put("polarisac.legacy.badpacketsr", "polarisac.badpackets.position_starvation");
        m.put("polarisac.legacy.badpacketss", "polarisac.badpackets.window_confirmation_not_accepted");
        m.put("polarisac.legacy.badpacketst", "polarisac.badpackets.invalid_interact_vector");
        m.put("polarisac.legacy.badpacketsw", "polarisac.badpackets.invalid_entity_target");
        m.put("polarisac.legacy.badpacketsx", "polarisac.badpackets.extra_input_actions");
        m.put("polarisac.legacy.badpacketsz", "polarisac.badpackets.duplicate_player_input");

        // Single-check categories.
        m.put("polarisac.legacy.chatc", "polarisac.chat.moving_while_chatting");
        m.put("polarisac.legacy.exploita", "polarisac.exploit.anvil_name_length");
        m.put("polarisac.legacy.groundspoof", "polarisac.groundspoof.fake");
        m.put("polarisac.legacy.timerlimit", "polarisac.timer.limit");

        // Elytra — every check fires when the player STARTS gliding under some
        // disallowed condition; the category implies the verb, the suffix is
        // just the condition.
        m.put("polarisac.legacy.elytraa", "polarisac.elytra.already_gliding");
        m.put("polarisac.legacy.elytrab", "polarisac.elytra.no_jump");
        m.put("polarisac.legacy.elytrac", "polarisac.elytra.too_frequent");
        m.put("polarisac.legacy.elytrad", "polarisac.elytra.no_elytra");
        m.put("polarisac.legacy.elytrae", "polarisac.elytra.flying");
        m.put("polarisac.legacy.elytraf", "polarisac.elytra.grounded");
        m.put("polarisac.legacy.elytrag", "polarisac.elytra.levitation");
        m.put("polarisac.legacy.elytrah", "polarisac.elytra.vehicle");
        m.put("polarisac.legacy.elytrai", "polarisac.elytra.water");

        // MultiActions — two simultaneous actions, named <verb>_while_<context>.
        m.put("polarisac.legacy.multiactionsa", "polarisac.multiactions.attack_while_using");
        m.put("polarisac.legacy.multiactionsb", "polarisac.multiactions.break_while_using");
        m.put("polarisac.legacy.multiactionsc", "polarisac.multiactions.inventory_click_while_moving");
        m.put("polarisac.legacy.multiactionsd", "polarisac.multiactions.inventory_close_while_moving");
        m.put("polarisac.legacy.multiactionse", "polarisac.multiactions.swing_while_using");
        m.put("polarisac.legacy.multiactionsf", "polarisac.multiactions.block_and_entity_interact");
        m.put("polarisac.legacy.multiactionsg", "polarisac.multiactions.action_while_rowing");

        // MultiInteract.
        m.put("polarisac.legacy.multiinteracta", "polarisac.multiinteract.multiple_targets");
        m.put("polarisac.legacy.multiinteractb", "polarisac.multiinteract.interact_at_position_changed");

        // PacketOrder — every check is "X happened in the wrong order"; the
        // <thing>_order suffix matches the colleague's naming style.
        m.put("polarisac.legacy.packetordera", "polarisac.packetorder.window_click_order");
        m.put("polarisac.legacy.packetorderb", "polarisac.packetorder.noswing");
        m.put("polarisac.legacy.packetorderc", "polarisac.packetorder.interact_order");
        m.put("polarisac.legacy.packetorderd", "polarisac.packetorder.interact_hand_order");
        m.put("polarisac.legacy.packetordere", "polarisac.packetorder.slot_order");
        m.put("polarisac.legacy.packetorderf", "polarisac.packetorder.input_tick_to_sneak_sprint_order");
        m.put("polarisac.legacy.packetorderg", "polarisac.packetorder.hotbar_inventory_manage_order");
        m.put("polarisac.legacy.packetorderh", "polarisac.packetorder.sneak_sprint_order");
        m.put("polarisac.legacy.packetorderi", "polarisac.packetorder.input_tick_order");
        m.put("polarisac.legacy.packetorderj", "polarisac.packetorder.attack_interact_use_order");
        m.put("polarisac.legacy.packetorderk", "polarisac.packetorder.inventory_open_order");
        m.put("polarisac.legacy.packetorderl", "polarisac.packetorder.drop_item_order");
        m.put("polarisac.legacy.packetorderm", "polarisac.packetorder.interact_use_order");
        m.put("polarisac.legacy.packetordern", "polarisac.packetorder.place_use_order");
        m.put("polarisac.legacy.packetordero", "polarisac.packetorder.tick_end_order");
        m.put("polarisac.legacy.packetorderp", "polarisac.packetorder.transaction_response_order");

        // Sprint — terse condition names; category implies "started sprinting".
        m.put("polarisac.legacy.sprinta", "polarisac.sprint.hunger");
        m.put("polarisac.legacy.sprintb", "polarisac.sprint.sneaking");
        m.put("polarisac.legacy.sprintc", "polarisac.sprint.using_item");
        m.put("polarisac.legacy.sprintd", "polarisac.sprint.blindness");
        m.put("polarisac.legacy.sprinte", "polarisac.sprint.wall");
        m.put("polarisac.legacy.sprintf", "polarisac.sprint.gliding");
        m.put("polarisac.legacy.sprintg", "polarisac.sprint.water");

        // Vehicle.
        m.put("polarisac.legacy.vehiclea", "polarisac.vehicle.impossible_input");
        m.put("polarisac.legacy.vehicleb", "polarisac.vehicle.spoofed_vehicle");
        m.put("polarisac.legacy.vehiclec", "polarisac.vehicle.vehicle_control");
        m.put("polarisac.legacy.vehicled", "polarisac.vehicle.spoofed_jump");
        m.put("polarisac.legacy.vehiclee", "polarisac.vehicle.spoofed_boat");
        m.put("polarisac.legacy.vehiclef", "polarisac.vehicle.boat_input_mismatch");

        OLD_TO_NEW = Collections.unmodifiableMap(m);
    }
}
