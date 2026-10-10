package com.scout.symbiote.network;

import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;
import net.neoforged.neoforge.network.handling.IPayloadContext;
import net.minecraft.server.level.ServerPlayer;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import java.util.function.Supplier;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.server.level.ServerPlayer;

public class ServerboundArmorSkinPacket implements CustomPacketPayload {
   public static final CustomPacketPayload.Type<ServerboundArmorSkinPacket> TYPE = new CustomPacketPayload.Type<>(ResourceLocation.fromNamespaceAndPath("symbiote", "serverbound_armor_skin_packet"));
   public static final StreamCodec<FriendlyByteBuf, ServerboundArmorSkinPacket> STREAM_CODEC = StreamCodec.of((buf, pkt) -> encode(pkt, buf), ServerboundArmorSkinPacket::decode);

   @Override
   public CustomPacketPayload.Type<ServerboundArmorSkinPacket> type() {
      return TYPE;
   }

   private static final int TOGGLE_COOLDOWN_TICKS = 20;

   public static void encode(ServerboundArmorSkinPacket pkt, FriendlyByteBuf buf) {
   }

   public static ServerboundArmorSkinPacket decode(FriendlyByteBuf buf) {
      return new ServerboundArmorSkinPacket();
   }

   public static void handle(ServerboundArmorSkinPacket pkt, IPayloadContext ctx) {
      ctx.enqueueWork(() -> {
         ServerPlayer player = (ServerPlayer)ctx.player();
         if (player != null) {
            SymbioteProfile p = SymbioteTracker.get(player.serverLevel()).peek(player.getUUID());
            if (p != null && p.stage.isBonded()) {
               long now = player.serverLevel().getGameTime();
               if (now - p.lastArmorSkinTick < 20L) {
                  SymbioteLog.event("ABILITY_REJECTED ability=armor_skin_toggle player={} reason=toggle_cooldown", player.getUUID());
               } else {
                  p.lastArmorSkinTick = now;
                  p.armorCoversGear = !p.armorCoversGear;
                  SymbioteTracker.get(player.serverLevel()).setDirty();
                  ModNetwork.broadcastLivingArmorState(player, p.livingArmorActive);
                  SymbioteLog.event("ARMOR_SKIN_TOGGLE player={} covers_gear={}", player.getUUID(), p.armorCoversGear);
               }
            }
         }
      });
   }
}
