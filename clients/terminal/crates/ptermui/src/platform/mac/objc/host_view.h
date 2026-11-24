#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

@interface NSPasteboard (PolarisTerminal)
- (NSArray *)getFilePaths;
@end

/// PtermHostView is the Content view of a Polaris Terminal window.
// It is backed by a Metal CALayer.
@interface PtermHostView : NSView <CALayerDelegate, NSTextInputClient>
- (PtermHostView *)initWithFrame:(NSRect)frame
                    metalDevice:(id)metalDevice
             enableTitlebarDrag:(BOOL)enableTitlebarDrag
                       testMode:(BOOL)testMode;
- (void)setAsyncCallback:(BOOL)shouldAsync;
- (void)setPresentsWithTransaction:(BOOL)presentsWithTransaction;
- (BOOL)keyDownImpl:(NSEvent *)event;
@end
