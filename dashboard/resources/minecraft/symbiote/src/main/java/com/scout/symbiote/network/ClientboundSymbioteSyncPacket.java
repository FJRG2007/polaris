package com.scout.symbiote.network;

import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;
import net.neoforged.neoforge.network.handling.IPayloadContext;
import net.minecraft.server.level.ServerPlayer;
import com.scout.symbiote.client.SymbioteClientState;
import com.scout.symbiote.client.armor.LivingArmorClientSizing;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import java.util.function.Supplier;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.world.item.ItemStack;

public class ClientboundSymbioteSyncPacket implements CustomPacketPayload {
   public static final CustomPacketPayload.Type<ClientboundSymbioteSyncPacket> TYPE = new CustomPacketPayload.Type<>(ResourceLocation.fromNamespaceAndPath("symbiote", "clientbound_symbiote_sync_packet"));
   public static final StreamCodec<RegistryFriendlyByteBuf, ClientboundSymbioteSyncPacket> STREAM_CODEC = StreamCodec.of((buf, pkt) -> encode(pkt, buf), ClientboundSymbioteSyncPacket::decode);

   @Override
   public CustomPacketPayload.Type<ClientboundSymbioteSyncPacket> type() {
      return TYPE;
   }

   private final int bond;
   private final int trust;
   private final int stress;
   private final int hunger;
   private final int livingArmorStamina;
   private final int stageOrdinal;
   private final int strainOrdinal;
   private final long dormantUntilTick;
   private final long instabilityUntilTick;
   private final boolean livingArmorActive;
   private final int stamina;
   private final int staminaMax;
   private final ItemStack[] armSlots;
   private final boolean mantleFurled;
   private int moodOrdinal = 1;
   private int temperamentOrdinal = 0;
   private int contrabandSlot = -1;
   private int graftStrain = -1;
   private int graftHunger = 0;
   private int graftTension = 0;
   private long bloomOpenTick = 0L;
   private long bloomUntilTick = 0L;

   public ClientboundSymbioteSyncPacket(
      int bond,
      int trust,
      int stress,
      int hunger,
      int livingArmorStamina,
      int stageOrdinal,
      int strainOrdinal,
      long dormantUntilTick,
      long instabilityUntilTick,
      boolean livingArmorActive,
      int stamina,
      int staminaMax,
      ItemStack[] armSlots,
      boolean mantleFurled
   ) {
      this.bond = bond;
      this.trust = trust;
      this.stress = stress;
      this.hunger = hunger;
      this.livingArmorStamina = livingArmorStamina;
      this.stageOrdinal = stageOrdinal;
      this.strainOrdinal = strainOrdinal;
      this.dormantUntilTick = dormantUntilTick;
      this.instabilityUntilTick = instabilityUntilTick;
      this.livingArmorActive = livingArmorActive;
      this.stamina = stamina;
      this.staminaMax = staminaMax;
      this.armSlots = armSlots;
      this.mantleFurled = mantleFurled;
   }

   public static ClientboundSymbioteSyncPacket of(SymbioteProfile p) {
      ClientboundSymbioteSyncPacket pkt = new ClientboundSymbioteSyncPacket(
         p.bond,
         p.trust,
         p.stress,
         p.hunger,
         p.livingArmorStamina,
         p.stage.ordinal(),
         p.strain.ordinal(),
         p.dormantUntilTick,
         p.instabilityUntilTick,
         p.livingArmorActive,
         p.stamina,
         p.staminaMax(),
         p.armSlots,
         p.mantleFurled
      );
      pkt.moodOrdinal = p.moodOrdinal;
      pkt.temperamentOrdinal = p.temperamentOrdinal;
      pkt.contrabandSlot = p.contrabandSlot;
      if (p.graft != null) {
         pkt.graftStrain = p.graft.strain == null ? 0 : p.graft.strain.ordinal();
         pkt.graftHunger = p.graft.hunger;
         pkt.graftTension = p.graft.tension;
      }

      pkt.bloomOpenTick = p.bloomOpenTick;
      pkt.bloomUntilTick = p.bloomUntilTick;
      return pkt;
   }

   public static ClientboundSymbioteSyncPacket empty() {
      return new ClientboundSymbioteSyncPacket(
         0, 50, 0, 70, 100, BondStage.UNBONDED.ordinal(), SymbioteStrain.GUARDIAN.ordinal(), 0L, 0L, false, 60, 60, new ItemStack[0], false
      );
   }

   public static void encode(ClientboundSymbioteSyncPacket pkt, RegistryFriendlyByteBuf buf) {
      buf.writeVarInt(pkt.bond);
      buf.writeVarInt(pkt.trust);
      buf.writeVarInt(pkt.stress);
      buf.writeVarInt(pkt.hunger);
      buf.writeVarInt(pkt.livingArmorStamina);
      buf.writeVarInt(pkt.stageOrdinal);
      buf.writeVarInt(pkt.strainOrdinal);
      buf.writeVarLong(pkt.dormantUntilTick);
      buf.writeVarLong(pkt.instabilityUntilTick);
      buf.writeBoolean(pkt.livingArmorActive);
      buf.writeVarInt(pkt.stamina);
      buf.writeVarInt(pkt.staminaMax);
      buf.writeVarInt(pkt.armSlots.length);

      for (ItemStack s : pkt.armSlots) {
         ItemStack.OPTIONAL_STREAM_CODEC.encode(buf, s == null ? ItemStack.EMPTY : s);
      }

      buf.writeBoolean(pkt.mantleFurled);
      buf.writeVarInt(pkt.moodOrdinal);
      buf.writeVarInt(pkt.temperamentOrdinal);
      buf.writeVarInt(pkt.contrabandSlot + 1);
      buf.writeVarInt(pkt.graftStrain + 1);
      buf.writeVarInt(pkt.graftHunger);
      buf.writeVarInt(pkt.graftTension);
      buf.writeVarLong(pkt.bloomOpenTick);
      buf.writeVarLong(pkt.bloomUntilTick);
   }

   public static ClientboundSymbioteSyncPacket decode(RegistryFriendlyByteBuf buf) {
      int bond = buf.readVarInt();
      int trust = buf.readVarInt();
      int stress = buf.readVarInt();
      int hunger = buf.readVarInt();
      int las = buf.readVarInt();
      int stage = buf.readVarInt();
      int strain = buf.readVarInt();
      long dormant = buf.readVarLong();
      long instab = buf.readVarLong();
      boolean armorActive = buf.readBoolean();
      int stamina = buf.readVarInt();
      int staminaMax = buf.readVarInt();
      int n = buf.readVarInt();
      ItemStack[] slots = new ItemStack[n];

      for (int i = 0; i < n; i++) {
         slots[i] = ItemStack.OPTIONAL_STREAM_CODEC.decode(buf);
      }

      boolean mantleFurled = buf.readBoolean();
      ClientboundSymbioteSyncPacket pkt = new ClientboundSymbioteSyncPacket(
         bond, trust, stress, hunger, las, stage, strain, dormant, instab, armorActive, stamina, staminaMax, slots, mantleFurled
      );
      pkt.moodOrdinal = buf.readVarInt();
      pkt.temperamentOrdinal = buf.readVarInt();
      pkt.contrabandSlot = buf.readVarInt() - 1;
      pkt.graftStrain = buf.readVarInt() - 1;
      pkt.graftHunger = buf.readVarInt();
      pkt.graftTension = buf.readVarInt();
      pkt.bloomOpenTick = buf.readVarLong();
      pkt.bloomUntilTick = buf.readVarLong();
      return pkt;
   }

   public static void handle(ClientboundSymbioteSyncPacket pkt, IPayloadContext ctx) {
      ctx.enqueueWork(
         () -> {
            SymbioteClientState.update(
               pkt.bond,
               pkt.trust,
               pkt.stress,
               pkt.hunger,
               pkt.livingArmorStamina,
               BondStage.fromOrdinalSafe(pkt.stageOrdinal),
               SymbioteStrain.fromOrdinalSafe(pkt.strainOrdinal),
               pkt.dormantUntilTick,
               pkt.instabilityUntilTick,
               pkt.livingArmorActive,
               pkt.stamina,
               pkt.staminaMax
            );
            SymbioteClientState.updateArmSlots(pkt.armSlots, pkt.mantleFurled);
            SymbioteClientState.updateMood(pkt.moodOrdinal, pkt.temperamentOrdinal);
            SymbioteClientState.updateContraband(pkt.contrabandSlot);
            SymbioteClientState.updateGraft(pkt.graftStrain, pkt.graftHunger, pkt.graftTension);
            SymbioteClientState.updateBloom(pkt.bloomOpenTick, pkt.bloomUntilTick);
            LivingArmorClientSizing.refreshLocalPlayerDimensions();
         }
      );
   }
}
