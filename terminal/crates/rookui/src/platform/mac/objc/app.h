#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#import <UserNotifications/UserNotifications.h>

// Our NSApplication subclass.
@interface RookApplication : NSApplication
@end

// RookDelegate is the delegate of the NSApp and also all menus.
@interface RookDelegate
    : NSObject <NSApplicationDelegate, NSMenuDelegate, UNUserNotificationCenterDelegate>

@property(strong) NSMenu *dockMenu;
- (BOOL)setDockIconVisible:(BOOL)visible;

@end

// Functions implemented in Rust.
void rook_app_will_finish_launching(id app);
void rook_app_did_become_active(id app);
void rook_app_did_resign_active(id app);
void rook_app_will_terminate(id app);
void rook_app_open_files(id app, id filenames);
void rook_app_send_global_keybinding(id app, NSUInteger modifiers, NSUInteger key_code);
void rook_app_new_window(id app);
void rook_app_window_did_resize(id app);
void rook_app_window_did_move(id app);
void rook_app_window_will_close(id app, id window);
void rook_app_screen_did_change(id app);
void cpu_awakened(id app);
void cpu_will_sleep(id app);
void rook_app_active_window_changed(id app);
void rook_app_notification_clicked(id app, double date, id data);
void rook_app_open_urls(id app, id urls);
void rook_app_os_appearance_changed(id app);
BOOL rook_app_should_terminate_app(id app, BOOL systemInitiated);
BOOL rook_app_should_close_window(id app, id window);
BOOL rook_app_are_key_bindings_disabled_for_window(id app, id window);
BOOL rook_app_has_binding_for_keystroke(id app, id event);
BOOL rook_app_has_custom_action_for_keystroke(id app, id event);
void rook_app_disable_warning_modal(id app);
void rook_app_internet_reachability_changed(id app, BOOL can_reach);
void rook_app_process_modal_response(id app, NSUInteger modal_id, NSModalResponse response,
                                     BOOL disable_modal);
