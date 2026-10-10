package com.scout.symbiote.network;

import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;
import net.neoforged.neoforge.network.handling.IPayloadContext;
import net.minecraft.server.level.ServerPlayer;
import com.scout.symbiote.client.SymbioteVoiceClient;
import java.util.function.Supplier;
import net.minecraft.network.FriendlyByteBuf;

public class ClientboundSubtitlePacket implements CustomPacketPayload {
   public static final CustomPacketPayload.Type<ClientboundSubtitlePacket> TYPE = new CustomPacketPayload.Type<>(ResourceLocation.fromNamespaceAndPath("symbiote", "clientbound_subtitle_packet"));
   public static final StreamCodec<FriendlyByteBuf, ClientboundSubtitlePacket> STREAM_CODEC = StreamCodec.of((buf, pkt) -> encode(pkt, buf), ClientboundSubtitlePacket::decode);

   @Override
   public CustomPacketPayload.Type<ClientboundSubtitlePacket> type() {
      return TYPE;
   }

   private final String key;
   private final int toneCode;
   private final int speakerStrain;

   public ClientboundSubtitlePacket(String key, int toneCode) {
      this(key, toneCode, -1);
   }

   public ClientboundSubtitlePacket(String key, int toneCode, int speakerStrain) {
      this.key = key;
      this.toneCode = toneCode;
      this.speakerStrain = speakerStrain;
   }

   public static void encode(ClientboundSubtitlePacket pkt, FriendlyByteBuf buf) {
      buf.writeUtf(pkt.key);
      buf.writeVarInt(pkt.toneCode);
      buf.writeVarInt(pkt.speakerStrain + 1);
   }

   public static ClientboundSubtitlePacket decode(FriendlyByteBuf buf) {
      return new ClientboundSubtitlePacket(buf.readUtf(), buf.readVarInt(), buf.readVarInt() - 1);
   }

   public static void handle(ClientboundSubtitlePacket pkt, IPayloadContext ctx) {
      ctx.enqueueWork(() -> SymbioteVoiceClient.show(pkt.key, pkt.toneCode, pkt.speakerStrain));
   }
}
