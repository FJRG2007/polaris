package com.scout.symbiote.network;

import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;
import net.neoforged.neoforge.network.handling.IPayloadContext;
import net.minecraft.server.level.ServerPlayer;
import com.scout.symbiote.client.SymbioteClientState;
import java.util.function.Supplier;
import net.minecraft.network.FriendlyByteBuf;

public class ClientboundBodySeizedPacket implements CustomPacketPayload {
   public static final CustomPacketPayload.Type<ClientboundBodySeizedPacket> TYPE = new CustomPacketPayload.Type<>(ResourceLocation.fromNamespaceAndPath("symbiote", "clientbound_body_seized_packet"));
   public static final StreamCodec<FriendlyByteBuf, ClientboundBodySeizedPacket> STREAM_CODEC = StreamCodec.of((buf, pkt) -> encode(pkt, buf), ClientboundBodySeizedPacket::decode);

   @Override
   public CustomPacketPayload.Type<ClientboundBodySeizedPacket> type() {
      return TYPE;
   }

   private final boolean seized;
   private final boolean marching;

   public ClientboundBodySeizedPacket(boolean seized, boolean marching) {
      this.seized = seized;
      this.marching = marching;
   }

   public static void encode(ClientboundBodySeizedPacket pkt, FriendlyByteBuf buf) {
      buf.writeBoolean(pkt.seized);
      buf.writeBoolean(pkt.marching);
   }

   public static ClientboundBodySeizedPacket decode(FriendlyByteBuf buf) {
      return new ClientboundBodySeizedPacket(buf.readBoolean(), buf.readBoolean());
   }

   public static void handle(ClientboundBodySeizedPacket pkt, IPayloadContext ctx) {
      ctx.enqueueWork(() -> SymbioteClientState.setBodySeized(pkt.seized, pkt.marching));
   }
}
