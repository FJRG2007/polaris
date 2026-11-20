package app.polaris.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class DeepLinkTest {
    @Test
    public void readsAPageOfAPolaris() {
        DeepLink link = DeepLink.read("polaris://open?server=https%3A%2F%2Fpolaris.example.com&path=%2Fchat%2Fgeneral%3Fm%3D1");
        assertEquals("https://polaris.example.com", link.server);
        assertEquals("/chat/general?m=1", link.path);
        assertEquals("https://polaris.example.com/chat/general?m=1", link.url());
    }

    @Test
    public void opensTheStartWhenNoPageIsNamed() {
        assertEquals("/", DeepLink.read("polaris://open?server=https%3A%2F%2Fpolaris.example.com").path);
    }

    @Test
    public void refusesALinkThatLeavesThePolarisItNames() {
        assertNull(DeepLink.read("polaris://open?server=https%3A%2F%2Fpolaris.example.com&path=%2F%2Fevil.example.com"));
        assertNull(DeepLink.read("polaris://open?server=https%3A%2F%2Fpolaris.example.com&path=https%3A%2F%2Fevil.example.com"));
        assertNull(DeepLink.read("polaris://open?server=https%3A%2F%2Fpolaris.example.com&path=%2F%5Cevil"));
        assertNull(DeepLink.read("polaris://open?server=javascript%3Aalert(1)"));
        assertNull(DeepLink.read("polaris://open?server=https%3A%2F%2Fuser%3Apw%40polaris.example.com"));
        assertNull(DeepLink.read("polaris://hosts?list=x"));
        assertNull(DeepLink.read("https://polaris.example.com/chat"));
        assertNull(DeepLink.read(null));
    }
}
