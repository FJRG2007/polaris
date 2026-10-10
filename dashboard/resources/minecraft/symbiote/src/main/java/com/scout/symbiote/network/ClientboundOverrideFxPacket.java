package com.scout.symbiote.network;

import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;
import net.neoforged.neoforge.network.handling.IPayloadContext;
import net.minecraft.server.level.ServerPlayer;
import com.scout.symbiote.client.OverrideFxClient;
import java.util.function.Supplier;
import net.minecraft.network.FriendlyByteBuf;

public class ClientboundOverrideFxPacket implements CustomPacketPayload {
   public static final CustomPacketPayload.Type<ClientboundOverrideFxPacket> TYPE = new CustomPacketPayload.Type<>(ResourceLocation.fromNamespaceAndPath("symbiote", "clientbound_override_fx_packet"));
   public static final StreamCodec<FriendlyByteBuf, ClientboundOverrideFxPacket> STREAM_CODEC = StreamCodec.of((buf, pkt) -> encode(pkt, buf), ClientboundOverrideFxPacket::decode);

   @Override
   public CustomPacketPayload.Type<ClientboundOverrideFxPacket> type() {
      return TYPE;
   }

   private final String fxId;
   private final int durationTicks;

   public ClientboundOverrideFxPacket(String fxId, int durationTicks) {
      this.fxId = fxId;
      this.durationTicks = durationTicks;
   }

   public static void encode(ClientboundOverrideFxPacket pkt, FriendlyByteBuf buf) {
      buf.writeUtf(pkt.fxId);
      buf.writeVarInt(pkt.durationTicks);
   }

   public static ClientboundOverrideFxPacket decode(FriendlyByteBuf buf) {
      return new ClientboundOverrideFxPacket(buf.readUtf(), buf.readVarInt());
   }

   public static void handle(ClientboundOverrideFxPacket pkt, IPayloadContext ctx) {
      ctx.enqueueWork(() -> OverrideFxClient.trigger(pkt.fxId, pkt.durationTicks));
   }
}
