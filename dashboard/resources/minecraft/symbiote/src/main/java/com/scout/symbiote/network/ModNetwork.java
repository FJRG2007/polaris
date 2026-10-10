package com.scout.symbiote.network;

import net.neoforged.neoforge.network.PacketDistributor;
import net.neoforged.neoforge.network.event.RegisterPayloadHandlersEvent;
import net.neoforged.neoforge.network.registration.PayloadRegistrar;
import com.scout.symbiote.command.PlayerCommandDispatcher;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import java.util.UUID;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;

public final class ModNetwork {
   private static final String PROTOCOL_VERSION = "1";

   public static void register(RegisterPayloadHandlersEvent event) {
      PayloadRegistrar registrar = event.registrar(PROTOCOL_VERSION);
      registrar.playToClient(ClientboundSymbioteSyncPacket.TYPE, ClientboundSymbioteSyncPacket.STREAM_CODEC, ClientboundSymbioteSyncPacket::handle);
      registrar.playToClient(ClientboundSubtitlePacket.TYPE, ClientboundSubtitlePacket.STREAM_CODEC, ClientboundSubtitlePacket::handle);
      registrar.playToClient(ClientboundOverrideFxPacket.TYPE, ClientboundOverrideFxPacket.STREAM_CODEC, ClientboundOverrideFxPacket::handle);
      registrar.playToServer(ServerboundAbilityPacket.TYPE, ServerboundAbilityPacket.STREAM_CODEC, ServerboundAbilityPacket::handle);
      registrar.playToServer(ServerboundCommandPacket.TYPE, ServerboundCommandPacket.STREAM_CODEC, ServerboundCommandPacket::handle);
      registrar.playToClient(ClientboundLivingArmorStatePacket.TYPE, ClientboundLivingArmorStatePacket.STREAM_CODEC, ClientboundLivingArmorStatePacket::handle);
      registrar.playToClient(ClientboundCommandModePacket.TYPE, ClientboundCommandModePacket.STREAM_CODEC, ClientboundCommandModePacket::handle);
      registrar.playToServer(ServerboundArmActionPacket.TYPE, ServerboundArmActionPacket.STREAM_CODEC, ServerboundArmActionPacket::handle);
      registrar.playToServer(ServerboundArmorSkinPacket.TYPE, ServerboundArmorSkinPacket.STREAM_CODEC, ServerboundArmorSkinPacket::handle);
      registrar.playToServer(ServerboundArmAssignPacket.TYPE, ServerboundArmAssignPacket.STREAM_CODEC, ServerboundArmAssignPacket::handle);
      registrar.playToClient(ClientboundBodySeizedPacket.TYPE, ClientboundBodySeizedPacket.STREAM_CODEC, ClientboundBodySeizedPacket::handle);
      registrar.playToClient(ClientboundSculkGlowPacket.TYPE, ClientboundSculkGlowPacket.STREAM_CODEC, ClientboundSculkGlowPacket::handle);
      registrar.playToServer(ServerboundGraftPacket.TYPE, ServerboundGraftPacket.STREAM_CODEC, ServerboundGraftPacket::handle);
   }

   public static void sendGraft(String action, String arg) {
      PacketDistributor.sendToServer(new ServerboundGraftPacket(action, arg));
   }

   public static void sendSculkGlow(ServerPlayer player, int[] entityIds, int durationTicks) {
      PacketDistributor.sendToPlayer(player, new ClientboundSculkGlowPacket(entityIds, durationTicks));
   }

   public static void sendBodySeized(ServerPlayer player, boolean seized, boolean marching) {
      PacketDistributor.sendToPlayer(player, new ClientboundBodySeizedPacket(seized, marching));
   }

   public static void syncToPlayer(ServerLevel level, ServerPlayer player) {
      SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
      ClientboundSymbioteSyncPacket pkt = p == null ? ClientboundSymbioteSyncPacket.empty() : ClientboundSymbioteSyncPacket.of(p);
      PacketDistributor.sendToPlayer(player, pkt);
   }

   public static void sendSubtitle(ServerPlayer player, String key, int toneCode) {
      PacketDistributor.sendToPlayer(player, new ClientboundSubtitlePacket(key, toneCode));
   }

   public static void sendSubtitle(ServerPlayer player, String key, int toneCode, int speakerStrain) {
      PacketDistributor.sendToPlayer(player, new ClientboundSubtitlePacket(key, toneCode, speakerStrain));
   }

   public static void sendOverrideFx(ServerPlayer player, String fxId, int durationTicks) {
      PacketDistributor.sendToPlayer(player, new ClientboundOverrideFxPacket(fxId, durationTicks));
   }

   public static void broadcastLivingArmorState(ServerPlayer player, boolean active) {
      SymbioteProfile p = SymbioteTracker.get(player.serverLevel()).peek(player.getUUID());
      boolean covers = p != null && p.armorCoversGear;
      int strain = p != null ? p.strain.ordinal() : 0;
      PacketDistributor.sendToPlayersTrackingEntityAndSelf(player, new ClientboundLivingArmorStatePacket(player.getUUID(), active, covers, strain)
      );
   }

   public static void sendArmorSkinToggle() {
      PacketDistributor.sendToServer(new ServerboundArmorSkinPacket());
   }

   public static void sendLivingArmorState(ServerPlayer viewer, UUID armoredPlayerId, boolean active, boolean coversGear, int strainOrdinal) {
      PacketDistributor.sendToPlayer(viewer, new ClientboundLivingArmorStatePacket(armoredPlayerId, active, coversGear, strainOrdinal));
   }

   public static void sendCommandMode(ServerPlayer player, PlayerCommandDispatcher.CommandMode mode) {
      PacketDistributor.sendToPlayer(player, new ClientboundCommandModePacket(mode.ordinal()));
   }

   private ModNetwork() {
   }
}
