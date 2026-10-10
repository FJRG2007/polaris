package com.scout.symbiote.tracker;

public final class MoodEngine {
   private static final int MOOD_BEAT_WINDOW = 6000;

   public static MoodEngine.Mood evaluate(SymbioteProfile p, long now) {
      if (now < p.moodDebugUntil) {
         return MoodEngine.Mood.values()[Math.floorMod(p.moodOrdinal, MoodEngine.Mood.values().length)];
      }

      if (now < p.grievingUntil) {
         return MoodEngine.Mood.GRIEVING;
      }

      int rapport = p.trust - p.stress;
      int recentNeg = 0;
      int recentPain = 0;

      for (SymbioteProfile.Beat b : p.beats) {
         if (now - b.tick <= 6000L) {
            if (b.weight < 0) {
               recentNeg += b.weight;
            }

            if (b.type == MoodEngine.BeatType.SPECIES_HURT.ordinal() || b.type == MoodEngine.BeatType.NEAR_DEATH.ordinal()) {
               recentPain++;
            }
         }
      }
      int woundBias = switch (p.strain) {
         case PREDATOR, ROYAL -> 8;
         case SHADOW -> 4;
         default -> 0;
      };

      int anxiousBias = switch (p.strain) {
         case GUARDIAN -> 10;
         case SCULK -> 6;
         default -> 0;
      };
      if (p.stress > 55 - woundBias || recentNeg <= -4 || p.isStarving()) {
         return MoodEngine.Mood.COILED;
      } else if (recentPain >= 1 || p.stress > 38 - anxiousBias || p.trust < (TrustRework.live() ? 45 : 35)) {
         return MoodEngine.Mood.ANXIOUS;
      } else {
         return rapport >= 20 ? MoodEngine.Mood.CONTENT : MoodEngine.Mood.ANXIOUS;
      }
   }

   public static String explain(SymbioteProfile p, long now, MoodEngine.Mood mood) {
      if (now < p.grievingUntil) {
         return "the loss";
      }

      int recentNeg = 0;
      int recentPain = 0;

      for (SymbioteProfile.Beat b : p.beats) {
         if (now - b.tick <= 6000L) {
            if (b.weight < 0) {
               recentNeg += b.weight;
            }

            if (b.type == MoodEngine.BeatType.SPECIES_HURT.ordinal() || b.type == MoodEngine.BeatType.NEAR_DEATH.ordinal()) {
               recentPain++;
            }
         }
      }
      return switch (mood) {
         case GRIEVING -> "the loss";
         case COILED -> p.isStarving() ? "starving" : (recentNeg <= -4 ? "how it's been treated" : "stress high");
         case ANXIOUS -> recentPain >= 1
            ? "fresh pain"
            : (p.stress > 30 ? "stress creeping" : (p.trust < (TrustRework.live() ? 45 : 35) ? "trust thin" : "watchful by nature"));
         case CONTENT -> "the bond sits warm";
      };
   }

   public static MoodEngine.Mood current(SymbioteProfile p) {
      return MoodEngine.Mood.values()[Math.floorMod(p.moodOrdinal, MoodEngine.Mood.values().length)];
   }

   public static MoodEngine.Temperament temperament(SymbioteProfile p) {
      return MoodEngine.Temperament.values()[Math.floorMod(p.temperamentOrdinal, MoodEngine.Temperament.values().length)];
   }

   public static double defianceScale(SymbioteProfile p) {
      return defianceMult(current(p)) * temperamentDefianceMult(temperament(p));
   }

   public static double defianceMult(MoodEngine.Mood mood) {
      return switch (mood) {
         case GRIEVING -> 0.8;
         case COILED -> 1.5;
         case ANXIOUS -> 1.0;
         case CONTENT -> 0.6;
      };
   }

   public static double temperamentDefianceMult(MoodEngine.Temperament t) {
      return switch (t) {
         case SOVEREIGN -> 0.5;
         case PARASITE -> 1.6;
         case MOURNER -> 0.9;
         case NONE -> 1.0;
      };
   }

   public static double curiosityMult(MoodEngine.Mood mood) {
      return switch (mood) {
         case GRIEVING, COILED -> 0.0;
         case ANXIOUS -> 0.5;
         case CONTENT -> 1.5;
      };
   }

   public static MoodEngine.Temperament stampTemperament(SymbioteProfile p) {
      int rapport = p.trust - p.stress;
      int griefMarks = 0;

      for (SymbioteProfile.Beat b : p.beats) {
         if (b.type == MoodEngine.BeatType.DEMOTION.ordinal() || b.type == MoodEngine.BeatType.STARVED.ordinal()) {
            griefMarks++;
         }
      }

      if (rapport >= 25) {
         return MoodEngine.Temperament.SOVEREIGN;
      } else {
         return griefMarks >= 3 && rapport > -10 ? MoodEngine.Temperament.MOURNER : MoodEngine.Temperament.PARASITE;
      }
   }

   private MoodEngine() {
   }

   public enum BeatType {
      FED(1),
      STARVED(-2),
      DESIRE_FULFILLED(2),
      DESIRE_IGNORED(-2),
      SAVE(1),
      STAND(3),
      TOOL_RECLAIMED(-3),
      SPECIES_HURT(0),
      DEMOTION(-2),
      NEAR_DEATH(0);

      public final int weight;

      BeatType(int weight) {
         this.weight = weight;
      }
   }

   public enum Mood {
      CONTENT,
      ANXIOUS,
      COILED,
      GRIEVING;
   }

   public enum Temperament {
      NONE,
      SOVEREIGN,
      PARASITE,
      MOURNER;
   }
}
