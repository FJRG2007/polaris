#import "menus.h"

void rook_menu_item_needs_update(NSMenuItem *, void *);
void rook_menu_item_triggered(NSMenuItem *, void *);
void rook_menu_item_deallocated(void *);

@implementation RookCustomMenuItemHandler

- (id)initWithContext:(void *)context {
    self = [super init];
    rustContext = context;
    return self;
}

- (void)itemWasTriggered:(NSMenuItem *)item {
    if (rustContext && ![item hasSubmenu]) rook_menu_item_triggered(item, rustContext);
}

- (void)itemNeedsUpdate:(NSMenuItem *)item {
    if (rustContext) rook_menu_item_needs_update(item, rustContext);
}

- (void)dealloc {
    if (rustContext) rook_menu_item_deallocated(rustContext);
    [super dealloc];
}

/// Our custom menu items set their enabled state in menuNeedsUpdate:, so do nothing here.
- (BOOL)validateMenuItem:(NSMenuItem *)menuItem {
    return menuItem.isEnabled;
}

@end

void set_menu_item_submenu(NSMenuItem *item, NSMenu *submenu) {
    if (submenu == nil) {
        [item setAction:@selector(itemWasTriggered:)];
    } else {
        [item setAction:NULL];
    }
    [item setSubmenu:submenu];
}
