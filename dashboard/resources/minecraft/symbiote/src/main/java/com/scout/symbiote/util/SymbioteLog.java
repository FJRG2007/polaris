package com.scout.symbiote.util;

import com.mojang.logging.LogUtils;
import com.scout.symbiote.config.SymbioteConfig;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.neoforged.fml.loading.FMLEnvironment;
import org.slf4j.Logger;
import org.slf4j.Marker;
import org.slf4j.MarkerFactory;

public final class SymbioteLog {
   public static final Logger LOGGER = LogUtils.getLogger();
   public static final Marker EVENT = MarkerFactory.getMarker("SYMBIOTE_EVENT");
   public static final Marker DEBUG = MarkerFactory.getMarker("SYMBIOTE_DEBUG");
   private static final Map<String, Integer> SKIP_TALLY = new ConcurrentHashMap<>();
   public static boolean verbose = false;

   private SymbioteLog() {
   }

   public static boolean verbose() {
      return loud();
   }

   private static boolean loud() {
      if (!FMLEnvironment.production) {
         return true;
      }

      try {
         return (Boolean)SymbioteConfig.VERBOSE_LOGGING.get();
      } catch (IllegalStateException notLoadedYet) {
         return false;
      }
   }

   public static void event(String fmt, Object... args) {
      if (loud()) {
         LOGGER.info(EVENT, fmt, args);
      } else {
         LOGGER.debug(EVENT, fmt, args);
      }
   }

   public static void notice(String fmt, Object... args) {
      LOGGER.info(EVENT, fmt, args);
   }

   public static void valueChange(UUID player, String field, int oldVal, int newVal, String cause) {
      if (oldVal != newVal) {
         if (!loud()) {
            LOGGER.debug(EVENT, "[{}] {} delta={} new={} (was {}) cause={}", new Object[]{player, field, newVal - oldVal, newVal, oldVal, cause});
         } else {
            LOGGER.info(EVENT, "[{}] {} delta={} new={} (was {}) cause={}", new Object[]{player, field, newVal - oldVal, newVal, oldVal, cause});
         }
      }
   }

   public static void overrideFired(UUID player, String type, String reason, Object... ctx) {
      if (!loud()) {
         LOGGER.debug(EVENT, "OVERRIDE_FIRED type={} player={} reason={} ctx={}", new Object[]{type, player, reason, formatCtx(ctx)});
      } else {
         LOGGER.info(EVENT, "OVERRIDE_FIRED type={} player={} reason={} ctx={}", new Object[]{type, player, reason, formatCtx(ctx)});
      }
   }

   public static void overrideSkipped(UUID player, String type, String reason) {
      String key = player + "|" + type + "|" + reason;
      int n = SKIP_TALLY.merge(key, 1, Integer::sum);
      if (n == 1 || n % 200 == 0) {
         if (!loud()) {
            LOGGER.debug(EVENT, "OVERRIDE_SKIPPED type={} player={} reason={} occurrences={}", new Object[]{type, player, reason, n});
            return;
         }

         LOGGER.info(EVENT, "OVERRIDE_SKIPPED type={} player={} reason={} occurrences={}", new Object[]{type, player, reason, n});
      }
   }

   public static void debug(String fmt, Object... args) {
      LOGGER.info(DEBUG, fmt, args);
   }

   private static String formatCtx(Object[] ctx) {
      if (ctx != null && ctx.length != 0) {
         StringBuilder sb = new StringBuilder("{");

         for (int i = 0; i + 1 < ctx.length; i += 2) {
            if (i > 0) {
               sb.append(", ");
            }

            sb.append(ctx[i]).append("=").append(ctx[i + 1]);
         }

         return sb.append("}").toString();
      } else {
         return "{}";
      }
   }
}
