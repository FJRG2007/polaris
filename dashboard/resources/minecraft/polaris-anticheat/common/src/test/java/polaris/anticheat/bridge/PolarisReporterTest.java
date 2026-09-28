package polaris.anticheat.bridge;

import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Handing flags to Polaris: only where Polaris set it up, and in JSON that a
 * player name or a check's verbose line cannot break.
 */
class PolarisReporterTest {
    private static final String ID = "01a0a00b-35c5-7932-861e-1b2161a9b298";

    @Test
    void doesNothingUnlessPolarisSetItUp() {
        assertNull(PolarisReporter.fromEnvironment(Map.of()));
        assertNull(PolarisReporter.fromEnvironment(Map.of(
                "POLARIS_ANTICHEAT", "off", "POLARIS_URL", "https://polaris.example",
                "POLARIS_SERVER_ID", ID, "POLARIS_SERVER_TOKEN", "t")));
        assertNull(PolarisReporter.fromEnvironment(Map.of(
                "POLARIS_ANTICHEAT", "on", "POLARIS_URL", "not an address",
                "POLARIS_SERVER_ID", ID, "POLARIS_SERVER_TOKEN", "t")));
        assertNull(PolarisReporter.fromEnvironment(Map.of(
                "POLARIS_ANTICHEAT", "on", "POLARIS_URL", "https://polaris.example",
                "POLARIS_SERVER_ID", "nope", "POLARIS_SERVER_TOKEN", "t")));
        assertNull(PolarisReporter.fromEnvironment(Map.of(
                "POLARIS_ANTICHEAT", "on", "POLARIS_URL", "https://polaris.example",
                "POLARIS_SERVER_ID", ID)));
        assertNotNull(PolarisReporter.fromEnvironment(Map.of(
                "POLARIS_ANTICHEAT", "on", "POLARIS_URL", "https://polaris.example/",
                "POLARIS_SERVER_ID", ID, "POLARIS_SERVER_TOKEN", "t")));
    }

    @Test
    void writesAFlagThatNothingInItCanBreak() {
        UUID uuid = UUID.fromString("b6f17181-9a33-35da-ac7a-dc016f891bd9");
        String json = PolarisReporter.flagJson("Steve", uuid, "Simulation", 25.9, "a \"quoted\"\\ line\n\u0001", 1000L);
        assertEquals("{\"player\":\"Steve\",\"uuid\":\"b6f17181-9a33-35da-ac7a-dc016f891bd9\",\"check\":\"Simulation\","
                + "\"vl\":25,\"verbose\":\"a \\\"quoted\\\"\\\\ line\\n\\u0001\",\"at\":1000}", json);
    }

    @Test
    void keepsAVerboseLineShortAndAViolationCountSane() {
        String json = PolarisReporter.flagJson("Steve", null, "Reach", 1e12, "x".repeat(1000), 1L);
        assertTrue(json.contains("\"vl\":1000000"));
        assertTrue(json.contains("\"verbose\":\"" + "x".repeat(PolarisReporter.VERBOSE_MAX) + "\""));
        assertTrue(json.contains("\"uuid\":\"\""));
    }
}
