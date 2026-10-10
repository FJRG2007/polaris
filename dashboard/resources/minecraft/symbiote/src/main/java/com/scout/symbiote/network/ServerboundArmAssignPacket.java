package com.scout.symbiote.network;

import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;
import net.neoforged.neoforge.network.handling.IPayloadContext;
import net.minecraft.server.level.ServerPlayer;
import com.scout.symbiote.ability.ArmWall;
import com.scout.symbiote.ability.TendrilMantle;
import com.scout.symbiote.menu.ArmContainer;
import com.scout.symbiote.menu.ArmSlotsMenu;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.function.Supplier;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.SimpleMenuProvider;
import net.minecraft.world.item.ItemStack;

public class ServerboundArmAssignPacket implements CustomPacketPayload {
   public static final CustomPacketPayload.Type<ServerboundArmAssignPacket> TYPE = new CustomPacketPayload.Type<>(ResourceLocation.fromNamespaceAndPath("symbiote", "serverbound_arm_assign_packet"));
   public static final StreamCodec<FriendlyByteBuf, ServerboundArmAssignPacket> STREAM_CODEC = StreamCodec.of((buf, pkt) -> encode(pkt, buf), ServerboundArmAssignPacket::decode);

   @Override
   public CustomPacketPayload.Type<ServerboundArmAssignPacket> type() {
      return TYPE;
   }

   public static final int OP_STASH = 0;
   public static final int OP_TOGGLE = 1;
   public static final int OP_OPEN = 2;
   public static final int OP_WALL = 3;
   private final int op;

   public ServerboundArmAssignPacket(int op) {
      this.op = op;
   }

   public static void encode(ServerboundArmAssignPacket pkt, FriendlyByteBuf buf) {
      buf.writeVarInt(pkt.op);
   }

   public static ServerboundArmAssignPacket decode(FriendlyByteBuf buf) {
      return new ServerboundArmAssignPacket(buf.readVarInt());
   }

   public static void handle(ServerboundArmAssignPacket pkt, IPayloadContext ctx) {
      ctx.enqueueWork(
         () -> {
            ServerPlayer player = (ServerPlayer)ctx.player();
            if (player != null) {
               ServerLevel level = player.serverLevel();
               SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
               if (p != null && p.stage.isBonded()) {
                  if (pkt.op != 2 && p.isDormant(level.getGameTime())) {
                     SymbioteLog.event("ABILITY_REJECTED ability=arm_assign_op{} player={} reason=dormant", pkt.op, player.getUUID());
                     VoiceLines.send(player, "symbiote.voice.dormant", 2);
                  } else if (pkt.op == 3) {
                     ArmWall.smartBuild(player, p);
                  } else if (pkt.op == 2) {
                     int unlocked = p.armSlotCount();
                     if (unlocked <= 0) {
                        VoiceLines.send(player, "symbiote.voice.arms_locked", 2);
                     } else {
                        ArmContainer container = new ArmContainer(p, level, player);
                        ItemStack carried = player.containerMenu.getCarried();
                        if (!carried.isEmpty()) {
                           player.containerMenu.setCarried(ItemStack.EMPTY);
                        }

                        player.openMenu(
                           new SimpleMenuProvider(
                              (id, inv, pl) -> new ArmSlotsMenu(id, inv, container, unlocked, p.contrabandSlot), Component.translatable("container.symbiote.arms")
                           ),
                           buf -> {
                              buf.writeByte(unlocked);
                              buf.writeByte(p.contrabandSlot);
                           }
                        );
                        if (!carried.isEmpty()) {
                           player.containerMenu.setCarried(carried);
                           player.containerMenu.broadcastChanges();
                        }
                     }
                  } else {
                     if (pkt.op == 1) {
                        TendrilMantle.hostFurlToggle(player, level, p);
                        SymbioteTracker.get(level).setDirty();
                     } else {
                        int slots = p.armSlotCount();
                        if (slots <= 0) {
                           VoiceLines.send(player, "symbiote.voice.arms_locked", 2);
                           return;
                        }

                        ItemStack held = player.getMainHandItem();
                        if (held.isEmpty()) {
                           for (int i = slots - 1; i >= 0; i--) {
                              if (!p.armSlots[i].isEmpty() && i != p.contrabandSlot) {
                                 ItemStack s = p.armSlots[i];
                                 if (!player.getInventory().add(s)) {
                                    player.drop(s, false);
                                 }

                                 p.armSlots[i] = ItemStack.EMPTY;
                                 break;
                              }
                           }
                        } else {
                           boolean took = false;
                           int free = -1;

                           for (int i = 0; i < slots; i++) {
                              if (p.armSlots[i].isEmpty()) {
                                 free = i;
                                 break;
                              }
                           }

                           if (free >= 0) {
                              p.armSlots[free] = held.copy();
                              player.setItemInHand(InteractionHand.MAIN_HAND, ItemStack.EMPTY);
                              took = true;
                           } else if (p.contrabandSlot != 0) {
                              ItemStack prev = p.armSlots[0];
                              p.armSlots[0] = held.copy();
                              player.setItemInHand(InteractionHand.MAIN_HAND, prev);
                              took = true;
                           }

                           if (took) {
                              VoiceLines.send(player, "symbiote.voice.arms_take", 0);
                           }
                        }

                        SymbioteTracker.get(level).setDirty();
                     }

                     ModNetwork.syncToPlayer(level, player);
                  }
               }
            }
         }
      );
   }
}
