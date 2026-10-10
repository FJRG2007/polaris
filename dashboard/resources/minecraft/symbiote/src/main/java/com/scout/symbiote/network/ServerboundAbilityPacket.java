package com.scout.symbiote.network;

import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;
import net.neoforged.neoforge.network.handling.IPayloadContext;
import net.minecraft.server.level.ServerPlayer;
import com.scout.symbiote.ability.AbilityDispatcher;
import java.util.function.Supplier;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.server.level.ServerPlayer;

public class ServerboundAbilityPacket implements CustomPacketPayload {
   public static final CustomPacketPayload.Type<ServerboundAbilityPacket> TYPE = new CustomPacketPayload.Type<>(ResourceLocation.fromNamespaceAndPath("symbiote", "serverbound_ability_packet"));
   public static final StreamCodec<FriendlyByteBuf, ServerboundAbilityPacket> STREAM_CODEC = StreamCodec.of((buf, pkt) -> encode(pkt, buf), ServerboundAbilityPacket::decode);

   @Override
   public CustomPacketPayload.Type<ServerboundAbilityPacket> type() {
      return TYPE;
   }

   private final String abilityId;

   public ServerboundAbilityPacket(String abilityId) {
      this.abilityId = abilityId;
   }

   public static void encode(ServerboundAbilityPacket pkt, FriendlyByteBuf buf) {
      buf.writeUtf(pkt.abilityId);
   }

   public static ServerboundAbilityPacket decode(FriendlyByteBuf buf) {
      return new ServerboundAbilityPacket(buf.readUtf());
   }

   public static void handle(ServerboundAbilityPacket pkt, IPayloadContext ctx) {
      ctx.enqueueWork(() -> {
         ServerPlayer player = (ServerPlayer)ctx.player();
         if (player != null) {
            AbilityDispatcher.activate(player, pkt.abilityId);
         }
      });
   }
}
