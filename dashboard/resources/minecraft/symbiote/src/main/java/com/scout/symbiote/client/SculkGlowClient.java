package com.scout.symbiote.client;

import com.scout.symbiote.SymbioteMod;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.util.SymbioteLog;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.Map.Entry;
import net.minecraft.client.Minecraft;
import net.minecraft.network.syncher.EntityDataAccessor;
import net.minecraft.world.entity.Entity;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote", value = Dist.CLIENT)
public final class SculkGlowClient {
   private static final int GLOW_BIT = 64;
   private static final Map<Integer, Long> LIT = new HashMap<>();
   private static final Set<Integer> PRE_GLOWING = new HashSet<>();
   private static final EntityDataAccessor<Byte> SHARED_FLAGS = findSharedFlags();

   public static Map<Integer, Long> litView() {
      return LIT;
   }

   public static void reset() {
      LIT.clear();
      PRE_GLOWING.clear();
   }

   private static EntityDataAccessor<Byte> findSharedFlags() {
      try {
         for (Field f : Entity.class.getDeclaredFields()) {
            if (Modifier.isStatic(f.getModifiers()) && f.getType() == EntityDataAccessor.class) {
               f.setAccessible(true);
               EntityDataAccessor<?> acc = (EntityDataAccessor<?>)f.get(null);
               if (acc != null && acc.id() == 0) {
                  return (EntityDataAccessor<Byte>)acc;
               }
            }
         }

         SymbioteMod.LOGGER.error("Sculk sonar: no EntityDataAccessor with id 0 on Entity, sonar dark");
      } catch (Throwable t) {
         SymbioteMod.LOGGER.error("Sculk sonar: shared-flags accessor lookup failed, sonar dark", t);
      }

      return null;
   }

   private static boolean glowBit(Entity e) {
      return SHARED_FLAGS != null && ((Byte)e.getEntityData().get(SHARED_FLAGS) & 64) != 0;
   }

   private static void paint(Entity e, boolean on) {
      if (SHARED_FLAGS != null) {
         byte b = (Byte)e.getEntityData().get(SHARED_FLAGS);
         byte nb = on ? (byte)(b | 64) : (byte)(b & -65);
         if (nb != b) {
            e.getEntityData().set(SHARED_FLAGS, nb);
         }
      }
   }

   public static void ping(int[] ids, int durationTicks) {
      Minecraft mc = Minecraft.getInstance();
      if (mc.level != null) {
         long until = mc.level.getGameTime() + durationTicks;
         boolean outlineMode = !ShaderDetect.shadersActive();
         int found = 0;
         int glowing = 0;

         for (int id : ids) {
            Entity e = mc.level.getEntity(id);
            if (e != null) {
               found++;
               if (outlineMode) {
                  if (!LIT.containsKey(id) && glowBit(e)) {
                     PRE_GLOWING.add(id);
                  }

                  paint(e, true);
               }

               if (e.isCurrentlyGlowing()) {
                  glowing++;
               }

               // 1.21.4 removed Entity#noCulling (frustum bypass); the glow outline itself needs no culling change.
               LIT.put(id, until);
            }
         }

         if ((Boolean)SymbioteConfig.VERBOSE_LOGGING.get()) {
            SymbioteLog.event("SCULK_GLOW_CLIENT sent={} found={} glowing={} outlineMode={}", ids.length, found, glowing, outlineMode);
         }
      }
   }

   @SubscribeEvent
   public static void onClientTick(ClientTickEvent.Post event) {
      if (!LIT.isEmpty()) {
         Minecraft mc = Minecraft.getInstance();
         if (mc.level == null) {
            LIT.clear();
            PRE_GLOWING.clear();
         } else {
            long now = mc.level.getGameTime();
            Iterator<Entry<Integer, Long>> it = LIT.entrySet().iterator();

            while (it.hasNext()) {
               Entry<Integer, Long> e = it.next();
               if (now >= e.getValue()) {
                  Entity ent = mc.level.getEntity(e.getKey());
                  if (ent != null) {
                     if (!PRE_GLOWING.contains(e.getKey())) {
                        paint(ent, false);
                     }

                  }

                  PRE_GLOWING.remove(e.getKey());
                  it.remove();
               }
            }
         }
      }
   }

   private SculkGlowClient() {
   }
}
