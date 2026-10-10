package com.scout.symbiote.compat;

import com.scout.symbiote.block.DeathCocoonBlock;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.item.ItemEntity;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import net.neoforged.bus.api.EventPriority;
import net.neoforged.bus.api.SubscribeEvent;
import top.theillusivec4.curios.api.event.CurioDropsEvent;

public final class CuriosRebondCompat {
   private static final Map<UUID, CuriosRebondCompat.Pending> PENDING = new HashMap<>();

   public static void trackMass(ServerPlayer host, DeathCocoonBlock.Entity mass) {
      PENDING.put(host.getUUID(), new CuriosRebondCompat.Pending(host, mass));
   }

   @SubscribeEvent(priority = EventPriority.LOWEST)
   public void onDrops(CurioDropsEvent event) {
      if (event.getEntity() instanceof ServerPlayer host) {
         CuriosRebondCompat.Pending pending = PENDING.remove(host.getUUID());
         if (pending != null && pending.host() == host) {
            DeathCocoonBlock.Entity mass = pending.mass();
            if (!mass.isRemoved() && mass.getLevel() == host.level() && host.getUUID().equals(mass.owner) && host.level().getBlockEntity(mass.getBlockPos()) == mass) {
               Iterator<ItemEntity> drops = event.getDrops().iterator();

               while (drops.hasNext()) {
                  ItemEntity drop = drops.next();
                  if (!drop.getItem().isEmpty()) {
                     mass.slotItems.add(new DeathCocoonBlock.Entity.SlotStack(Integer.MAX_VALUE, drop.getItem()));
                     drops.remove();
                     mass.setChanged();
                  }
               }
            }
         }
      }
   }

   @SubscribeEvent
   public void onServerTick(ServerTickEvent.Post event) {
      if (true) {
         PENDING.clear();
      }
   }

   private record Pending(ServerPlayer host, DeathCocoonBlock.Entity mass) {
   }
}
