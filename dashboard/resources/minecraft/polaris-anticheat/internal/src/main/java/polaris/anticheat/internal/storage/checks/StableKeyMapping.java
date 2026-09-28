package polaris.anticheat.internal.storage.checks;

import org.jetbrains.annotations.ApiStatus;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * Bridges legacy {@code polarisac_history_check_names} display strings to the v1
 * schema's {@code stable_key} column.
 * <p>
 * Two consumers:
 * <ul>
 *   <li>v0 → v1 migration: {@code LegacyMigrator} resolves every distinct
 *       {@code check_name_string} through this map so historical violations
 *       land on the new schema with a meaningful stable_key.</li>
 *   <li>Live-write fallback: {@code LiveWriteHooks} consults this map when a
 *       Check hasn't declared a {@code stableKey} on its {@code @CheckData}
 *       / {@code CheckInfo}.</li>
 * </ul>
 * <p>
 * Unknown names hit the {@link #legacyFallback} path so migration always
 * completes; operators can rename the fallback keys later through the check
 * registry if they want.
 */
@ApiStatus.Internal
public final class StableKeyMapping {

    private static final Map<String, String> MAPPINGS = buildMappings();

    private StableKeyMapping() {}

    public static Optional<String> stableKeyFor(String legacyDisplayName) {
        if (legacyDisplayName == null) return Optional.empty();
        return Optional.ofNullable(MAPPINGS.get(legacyDisplayName.toLowerCase(Locale.ROOT)));
    }

    public static String legacyFallback(String legacyDisplayName) {
        return "polarisac.legacy." + legacyDisplayName.toLowerCase(Locale.ROOT);
    }

    private static Map<String, String> buildMappings() {
        // Keys: lowercased legacy display names (the {@code check_name_string}
        // column in the v0 schema, plus any {@code Check.getCheckName()} a
        // live writer might emit).
        // Values: stable_keys declared via @CheckData.stableKey on the
        // matching Check class. Entries for retired check classes that have
        // no live source-of-truth keep their {@code polarisac.legacy.*} key so
        // historical violations stay addressable.
        Map<String, String> m = new HashMap<>(160);

        // ---------- badpackets/ ----------
        m.put("badpacketsa", "polarisac.badpackets.duplicate_slot");
        m.put("badpacketsd", "polarisac.badpackets.invalid_pitch");
        m.put("badpacketse", "polarisac.badpackets.invalid_position");
        m.put("badpacketsf", "polarisac.badpackets.duplicate_sprint");
        m.put("badpacketsg", "polarisac.badpackets.duplicate_sneak");
        m.put("badpacketsi", "polarisac.badpackets.spoofed_abilities");
        m.put("badpacketsk", "polarisac.badpackets.invalid_spectate");
        m.put("badpacketsl", "polarisac.badpackets.invalid_dig");
        m.put("badpacketsm", "polarisac.badpackets.respawn_alive");
        m.put("badpacketsn", "polarisac.badpackets.invalid_teleport");
        m.put("badpacketso", "polarisac.badpackets.invalid_keepalive");
        m.put("badpacketsp", "polarisac.badpackets.invalid_click");
        m.put("badpacketsq", "polarisac.badpackets.invalid_horse_jump");
        m.put("badpacketsu", "polarisac.badpackets.invalid_block_placement");
        m.put("badpacketsv", "polarisac.badpackets.slow_move");
        m.put("badpacketsy", "polarisac.badpackets.oob_slot");
        m.put("badpacketsb", "polarisac.badpackets.ignored_rotation");
        m.put("badpacketsc", "polarisac.badpackets.wake_not_sleeping");
        m.put("badpacketsh", "polarisac.badpackets.unexpected_sequence");
        m.put("badpacketsj", "polarisac.badpackets.use_item_rotation_mismatch");
        m.put("badpacketsr", "polarisac.badpackets.position_starvation");
        m.put("badpacketss", "polarisac.badpackets.window_confirmation_not_accepted");
        m.put("badpacketst", "polarisac.badpackets.invalid_interact_vector");
        m.put("badpacketsw", "polarisac.badpackets.invalid_entity_target");
        m.put("badpacketsx", "polarisac.badpackets.extra_input_actions");
        m.put("badpacketsz", "polarisac.badpackets.duplicate_player_input");
        m.put("selfinteract", "polarisac.badpackets.self_hit");

        // ---------- crash/ ----------
        m.put("crasha", "polarisac.crash.large_position");
        m.put("crashb", "polarisac.crash.creative_while_not_creative");
        m.put("crashc", "polarisac.crash.nan_position");
        m.put("crashd", "polarisac.crash.lectern");
        m.put("crashe", "polarisac.crash.low_view_distance");
        m.put("crashf", "polarisac.crash.button_crash");
        m.put("crashg", "polarisac.crash.negative_sequence");
        m.put("crashh", "polarisac.crash.invalid_tab_complete");
        m.put("crashi", "polarisac.crash.invalid_bundle_slot");

        // ---------- combat/ ----------
        m.put("hitboxes", "polarisac.combat.hitboxes");
        m.put("reach", "polarisac.combat.reach");

        // ---------- aim/ ----------
        m.put("aimduplicatelook", "polarisac.aim.duplicate_look");
        m.put("aimmodulo360", "polarisac.aim.modulo_360");
        m.put("aimfold", "polarisac.legacy.aimfold");
        m.put("aimgold", "polarisac.legacy.aimgold");
        m.put("aimhold", "polarisac.legacy.aimhold");

        // ---------- breaking/ ----------
        m.put("airliquidbreak", "polarisac.breaking.air_liquid_break");
        m.put("farbreak", "polarisac.breaking.far_break");
        m.put("fastbreak", "polarisac.breaking.fast_break");
        m.put("invalidbreak", "polarisac.breaking.invalid_break");
        m.put("multibreak", "polarisac.breaking.multi_break");
        m.put("noswingbreak", "polarisac.breaking.no_swing_break");
        m.put("positionbreaka", "polarisac.breaking.position_break_a");
        m.put("positionbreakb", "polarisac.breaking.position_break_b");
        m.put("rotationbreak", "polarisac.breaking.rotation_break");
        m.put("wrongbreak", "polarisac.breaking.wrong_break");

        // ---------- scaffolding/ ----------
        m.put("airliquidplace", "polarisac.scaffolding.air_liquid_place");
        m.put("duplicaterotplace", "polarisac.scaffolding.duplicate_rot_place");
        m.put("fabricatedplace", "polarisac.scaffolding.fabricated_place");
        m.put("farplace", "polarisac.scaffolding.far_place");
        m.put("invalidplacea", "polarisac.scaffolding.invalid_place_a");
        m.put("invalidplaceb", "polarisac.scaffolding.invalid_place_b");
        m.put("multiplace", "polarisac.scaffolding.multi_place");
        m.put("positionplace", "polarisac.scaffolding.position_place");
        m.put("rotationplace", "polarisac.scaffolding.rotation_place");

        // ---------- chat/ ----------
        m.put("chatc", "polarisac.chat.moving_while_chatting");

        // ---------- exploit/ ----------
        m.put("chata", "polarisac.exploit.blank_tab_complete");
        m.put("chatb", "polarisac.exploit.spigot_antispam_bypass");
        m.put("chatd", "polarisac.exploit.chat_while_hidden");
        m.put("exploita", "polarisac.exploit.anvil_name_length");
        m.put("exploitb", "polarisac.exploit.invalid_book_edit");
        m.put("exploitc", "polarisac.legacy.exploitc");

        // ---------- prediction/ ----------
        m.put("phase", "polarisac.prediction.phase");

        // ---------- movement/ ----------
        m.put("noslow", "polarisac.movement.noslow");

        // ---------- groundspoof/ ----------
        m.put("groundspoof", "polarisac.groundspoof.fake");
        m.put("nofall", "polarisac.groundspoof.no_fall");

        // ---------- post/ ----------
        m.put("post", "polarisac.post.invalid_order");

        // ---------- ping/ ----------
        m.put("transactionorder", "polarisac.ping.invalid_transaction_order");

        // ---------- baritone/ ----------
        m.put("baritone", "polarisac.baritone.baritone");

        // ---------- timer/ ----------
        m.put("negativetimer", "polarisac.timer.negative");
        m.put("ticktimer", "polarisac.timer.tick");
        m.put("timer", "polarisac.timer.timer");
        m.put("timerlimit", "polarisac.timer.limit");
        m.put("vehicletimer", "polarisac.timer.vehicle");

        // ---------- elytra/ ----------
        m.put("elytraa", "polarisac.elytra.already_gliding");
        m.put("elytrab", "polarisac.elytra.no_jump");
        m.put("elytrac", "polarisac.elytra.too_frequent");
        m.put("elytrad", "polarisac.elytra.no_elytra");
        m.put("elytrae", "polarisac.elytra.flying");
        m.put("elytraf", "polarisac.elytra.grounded");
        m.put("elytrag", "polarisac.elytra.levitation");
        m.put("elytrah", "polarisac.elytra.vehicle");
        m.put("elytrai", "polarisac.elytra.water");

        // ---------- sprint/ ----------
        m.put("sprinta", "polarisac.sprint.hunger");
        m.put("sprintb", "polarisac.sprint.sneaking");
        m.put("sprintc", "polarisac.sprint.using_item");
        m.put("sprintd", "polarisac.sprint.blindness");
        m.put("sprinte", "polarisac.sprint.wall");
        m.put("sprintf", "polarisac.sprint.gliding");
        m.put("sprintg", "polarisac.sprint.water");

        // ---------- vehicle/ ----------
        m.put("vehiclea", "polarisac.vehicle.impossible_input");
        m.put("vehicleb", "polarisac.vehicle.spoofed_vehicle");
        m.put("vehiclec", "polarisac.vehicle.vehicle_control");
        m.put("vehicled", "polarisac.vehicle.spoofed_jump");
        m.put("vehiclee", "polarisac.vehicle.spoofed_boat");
        m.put("vehiclef", "polarisac.vehicle.boat_input_mismatch");

        // ---------- multiactions/ ----------
        m.put("multiactionsa", "polarisac.multiactions.attack_while_using");
        m.put("multiactionsb", "polarisac.multiactions.break_while_using");
        m.put("multiactionsc", "polarisac.multiactions.inventory_click_while_moving");
        m.put("multiactionsd", "polarisac.multiactions.inventory_close_while_moving");
        m.put("multiactionse", "polarisac.multiactions.swing_while_using");
        m.put("multiactionsf", "polarisac.multiactions.block_and_entity_interact");
        m.put("multiactionsg", "polarisac.multiactions.action_while_rowing");

        // ---------- multiinteract/ ----------
        m.put("multiinteracta", "polarisac.multiinteract.multiple_targets");
        m.put("multiinteractb", "polarisac.multiinteract.interact_at_position_changed");

        // ---------- packetorder/ ----------
        m.put("packetordera", "polarisac.packetorder.window_click_order");
        m.put("packetorderb", "polarisac.packetorder.noswing");
        m.put("packetorderc", "polarisac.packetorder.interact_order");
        m.put("packetorderd", "polarisac.packetorder.interact_hand_order");
        m.put("packetordere", "polarisac.packetorder.slot_order");
        m.put("packetorderf", "polarisac.packetorder.input_tick_to_sneak_sprint_order");
        m.put("packetorderg", "polarisac.packetorder.hotbar_inventory_manage_order");
        m.put("packetorderh", "polarisac.packetorder.sneak_sprint_order");
        m.put("packetorderi", "polarisac.packetorder.input_tick_order");
        m.put("packetorderj", "polarisac.packetorder.attack_interact_use_order");
        m.put("packetorderk", "polarisac.packetorder.inventory_open_order");
        m.put("packetorderl", "polarisac.packetorder.drop_item_order");
        m.put("packetorderm", "polarisac.packetorder.interact_use_order");
        m.put("packetordern", "polarisac.packetorder.place_use_order");
        m.put("packetordero", "polarisac.packetorder.tick_end_order");
        m.put("packetorderp", "polarisac.packetorder.transaction_response_order");

        // ---------- misc-legacy/ ----------
        m.put("looka", "polarisac.legacy.looka");
        m.put("clientbrand", "polarisac.legacy.clientbrand");
        m.put("inventorya", "polarisac.legacy.inventorya");
        m.put("inventoryb", "polarisac.legacy.inventoryb");
        m.put("inventoryc", "polarisac.legacy.inventoryc");
        m.put("inventoryd", "polarisac.legacy.inventoryd");
        m.put("inventorye", "polarisac.legacy.inventorye");
        m.put("inventoryf", "polarisac.legacy.inventoryf");
        m.put("inventoryg", "polarisac.legacy.inventoryg");

        return Map.copyOf(m);
    }
}

