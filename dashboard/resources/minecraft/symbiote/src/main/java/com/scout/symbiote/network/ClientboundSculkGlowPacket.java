package com.scout.symbiote.network;

import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;
import net.neoforged.neoforge.network.handling.IPayloadContext;
import net.minecraft.server.level.ServerPlayer;
import com.scout.symbiote.client.SculkGlowClient;
import java.util.function.Supplier;
import net.minecraft.network.FriendlyByteBuf;

public class ClientboundSculkGlowPacket implements CustomPacketPayload {
   public static final CustomPacketPayload.Type<ClientboundSculkGlowPacket> TYPE = new CustomPacketPayload.Type<>(ResourceLocation.fromNamespaceAndPath("symbiote", "clientbound_sculk_glow_packet"));
   public static final StreamCodec<FriendlyByteBuf, ClientboundSculkGlowPacket> STREAM_CODEC = StreamCodec.of((buf, pkt) -> encode(pkt, buf), ClientboundSculkGlowPacket::decode);

   @Override
   public CustomPacketPayload.Type<ClientboundSculkGlowPacket> type() {
      return TYPE;
   }

   private final int[] entityIds;
   private final int durationTicks;

   public ClientboundSculkGlowPacket(int[] entityIds, int durationTicks) {
      this.entityIds = entityIds;
      this.durationTicks = durationTicks;
   }

   public static void encode(ClientboundSculkGlowPacket pkt, FriendlyByteBuf buf) {
      buf.writeVarIntArray(pkt.entityIds);
      buf.writeVarInt(pkt.durationTicks);
   }

   public static ClientboundSculkGlowPacket decode(FriendlyByteBuf buf) {
      return new ClientboundSculkGlowPacket(buf.readVarIntArray(), buf.readVarInt());
   }

   public static void handle(ClientboundSculkGlowPacket pkt, IPayloadContext ctx) {
      ctx.enqueueWork(() -> SculkGlowClient.ping(pkt.entityIds, pkt.durationTicks));
   }
}
