package polaris.anticheat.internal.event;

import polaris.anticheat.api.event.AbstractEventChannel;
import polaris.anticheat.api.event.EventChannel;
import polaris.anticheat.api.event.PolarisEvent;
import polaris.anticheat.api.event.ListenerPriority;
import polaris.anticheat.api.plugin.BasicPolarisPlugin;
import polaris.anticheat.api.plugin.PolarisPlugin;
import polaris.anticheat.internal.plugin.resolver.PolarisExtensionManager;
import org.jetbrains.annotations.NotNull;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.logging.Logger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Covers the bridge-listener pattern that powers abstract-event subscription.
 *
 * <p>Uses a hand-rolled event hierarchy — an abstract {@code Animal} with two
 * concrete subtypes {@code Dog} / {@code Cat} — so the tests don't depend on
 * the built-in Polaris event wiring.
 */
class AbstractChannelBridgeTest {

    // ── Fixtures ───────────────────────────────────────────────────────────

    /** Abstract event — never instantiated, exists only as a subscribe target. */
    public static abstract class Animal<CHANNEL extends EventChannel<?, ?>> extends PolarisEvent<CHANNEL> {
        @FunctionalInterface
        public interface Handler {
            void onAnimal(@NotNull String species);
        }

        public static final class Channel extends AbstractEventChannel<Animal<?>, Handler> {
            @SuppressWarnings({"unchecked", "rawtypes"})
            public Channel() { super((Class<Animal<?>>) (Class) Animal.class, Handler.class); }

            public void onAnimal(@NotNull PolarisPlugin plugin, @NotNull Handler h) {
                subscribeAbstract(h, ListenerPriority.NORMAL, false, plugin);
            }

            public void onAnimal(@NotNull PolarisPlugin plugin, @NotNull Handler h, int priority) {
                subscribeAbstract(h, priority, false, plugin);
            }
        }
    }

    public static final class Dog extends Animal<Dog.Channel> {
        @FunctionalInterface
        public interface Handler { void onDog(@NotNull String name); }

        public static final class Channel extends EventChannel<Dog, Handler> {
            public Channel() { super(Dog.class, Handler.class); }

            public void onDog(@NotNull PolarisPlugin plugin, @NotNull Handler h) {
                subscribe(h, ListenerPriority.NORMAL, false, plugin, null);
            }

            public void fire(@NotNull String name) {
                for (Entry<Handler> e : entries()) {
                    try { e.handler.onDog(name); } catch (Throwable t) { t.printStackTrace(); }
                }
            }

            @Override
            protected boolean dispatchTypedFromLegacy(@NotNull Dog event, @NotNull Handler handler, boolean cancelled) { return false; }

            /** Bridge from Animal abstract subscribe. */
            public static @NotNull Handler bridgeFromAnimal(@NotNull Animal.Handler abstractHandler) {
                return name -> abstractHandler.onAnimal("Dog(" + name + ")");
            }
        }
    }

    public static final class Cat extends Animal<Cat.Channel> {
        @FunctionalInterface
        public interface Handler { void onCat(@NotNull String name); }

        public static final class Channel extends EventChannel<Cat, Handler> {
            public Channel() { super(Cat.class, Handler.class); }

            public void onCat(@NotNull PolarisPlugin plugin, @NotNull Handler h) {
                subscribe(h, ListenerPriority.NORMAL, false, plugin, null);
            }

            public void onCat(@NotNull PolarisPlugin plugin, @NotNull Handler h, int priority) {
                subscribe(h, priority, false, plugin, null);
            }

            public void fire(@NotNull String name) {
                for (Entry<Handler> e : entries()) {
                    try { e.handler.onCat(name); } catch (Throwable t) { t.printStackTrace(); }
                }
            }

            @Override
            protected boolean dispatchTypedFromLegacy(@NotNull Cat event, @NotNull Handler handler, boolean cancelled) { return false; }

            public static @NotNull Handler bridgeFromAnimal(@NotNull Animal.Handler abstractHandler) {
                return name -> abstractHandler.onAnimal("Cat(" + name + ")");
            }
        }
    }

    private PolarisPlugin plugin;
    private Animal.Channel animalCh;
    private Dog.Channel dogCh;
    private Cat.Channel catCh;

    @BeforeEach
    void setUp() {
        plugin = new BasicPolarisPlugin(Logger.getLogger("t"), new File("/tmp"), "0", "", Collections.emptyList());
        animalCh = new Animal.Channel();
        dogCh = new Dog.Channel();
        catCh = new Cat.Channel();
        // Bridge tests don't need the full bus — the bridge pattern lives
        // entirely between AbstractEventChannel and its concrete children.
    }

    // ── Non-negotiable tests ───────────────────────────────────────────────

    @Test
    void abstractSubscribeThenLateSubtypeRegister_thenFire_listenerFires() {
        // Only Dog is wired to Animal at start. Cat will be registered AFTER
        // the abstract subscribe.
        animalCh.registerSubtype(Dog.class, dogCh, Dog.Channel::bridgeFromAnimal);

        List<String> seen = new ArrayList<>();
        animalCh.onAnimal(plugin, seen::add);

        // Late addon subtype registration — must walk existing subscribers.
        animalCh.registerSubtype(Cat.class, catCh, Cat.Channel::bridgeFromAnimal);

        dogCh.fire("Rex");
        catCh.fire("Whiskers");

        assertEquals(List.of("Dog(Rex)", "Cat(Whiskers)"), seen);
    }

    @Test
    void registerSubtypeThenAbstractSubscribe_thenFire_listenerFires() {
        // All subtypes registered first.
        animalCh.registerSubtype(Dog.class, dogCh, Dog.Channel::bridgeFromAnimal);
        animalCh.registerSubtype(Cat.class, catCh, Cat.Channel::bridgeFromAnimal);

        // Subscribe after — bridges install into every registered child.
        List<String> seen = new ArrayList<>();
        animalCh.onAnimal(plugin, seen::add);

        dogCh.fire("Fido");
        catCh.fire("Mittens");

        assertEquals(List.of("Dog(Fido)", "Cat(Mittens)"), seen);
    }

    @Test
    void maxValueAbstractPriorityRunsBeforeMonitorOnLateSubtype() {
        List<String> order = new ArrayList<>();
        animalCh.onAnimal(plugin, species -> order.add("abstract-max"), Integer.MAX_VALUE);

        animalCh.registerSubtype(Cat.class, catCh, Cat.Channel::bridgeFromAnimal);
        catCh.onCat(plugin, name -> order.add("monitor"), ListenerPriority.MONITOR);
        catCh.fire("Mittens");

        assertEquals(List.of("abstract-max", "monitor"), order);
    }

    @Test
    void unsubscribeFromAbstract_sweepsBridgesFromEveryConcreteChannel() {
        animalCh.registerSubtype(Dog.class, dogCh, Dog.Channel::bridgeFromAnimal);
        animalCh.registerSubtype(Cat.class, catCh, Cat.Channel::bridgeFromAnimal);

        AtomicInteger count = new AtomicInteger();
        Animal.Handler handler = species -> count.incrementAndGet();
        animalCh.onAnimal(plugin, handler);

        dogCh.fire("A");
        catCh.fire("B");
        assertEquals(2, count.get());

        animalCh.unsubscribe(handler);

        dogCh.fire("C");
        catCh.fire("D");
        assertEquals(2, count.get(), "no further hits after unsubscribe");
        assertTrue(dogCh.isEmpty(), "dog channel has no bridges left");
        assertTrue(catCh.isEmpty(), "cat channel has no bridges left");
    }
}
