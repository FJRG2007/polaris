package polaris.anticheat.bridge;

import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PolarisTrapsTest {
    @Test
    void readsEveryTrapPerDimension() {
        LongOpenHashSet[] traps = PolarisTraps.parse("{\"traps\":[[0,120,-40,-8],[1,-5,15,300],[0,-30000000,-64,29999999]]}");
        assertTrue(traps[PolarisTraps.OVERWORLD].contains(PolarisTraps.pack(120, -40, -8)));
        assertTrue(traps[PolarisTraps.OVERWORLD].contains(PolarisTraps.pack(-30000000, -64, 29999999)));
        assertTrue(traps[PolarisTraps.NETHER].contains(PolarisTraps.pack(-5, 15, 300)));
        assertFalse(traps[PolarisTraps.NETHER].contains(PolarisTraps.pack(120, -40, -8)));
    }

    @Test
    void readsNothingFromSomethingElse() {
        assertEquals(0, PolarisTraps.parse("{\"error\":\"unauthorized\"}")[0].size());
        assertEquals(0, PolarisTraps.parse(null)[1].size());
        assertEquals(0, PolarisTraps.parse("[[7,1,2,3]]")[0].size());
    }

    @Test
    void keepsAtMostWhatPolarisEverPlaces() {
        StringBuilder body = new StringBuilder("{\"traps\":[");
        for (int i = 0; i < PolarisTraps.MAX_TRAPS + 50; i++) body.append(i == 0 ? "" : ",").append("[0,").append(i).append(",0,0]");
        assertEquals(PolarisTraps.MAX_TRAPS, PolarisTraps.parse(body.append("]}").toString())[0].size());
    }

    @Test
    void answersForTheListItWasGiven() {
        PolarisTraps.accept("{\"traps\":[[0,1,2,3]]}");
        assertTrue(PolarisTraps.isTrap(PolarisTraps.OVERWORLD, 1, 2, 3));
        assertFalse(PolarisTraps.isTrap(PolarisTraps.NETHER, 1, 2, 3));
        assertFalse(PolarisTraps.isTrap(-1, 1, 2, 3));
        PolarisTraps.accept("{\"traps\":[]}");
        assertFalse(PolarisTraps.isTrap(PolarisTraps.OVERWORLD, 1, 2, 3));
    }
}
