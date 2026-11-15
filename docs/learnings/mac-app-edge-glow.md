# Mac app: Dictate edge glow

Learnings from the glow around the window being dictated into (`docs/PLAN-dictate-edge-glow.md`).

- **A shell on the build Mac usually can't screenshot.** `screencapture` fails with "could not
  create image from display" without Screen Recording. Render the layers to a PNG instead:
  `CALayer.render(in:)` drew our gradient masks and shadows correctly on macOS 27, despite the docs
  saying masks aren't supported. `--render-edge-glow <folder>` does this.
- **Calling the Accessibility API from an untrusted binary can put a permission prompt on the
  owner's screen** (`universalAccessAuthWarn`). Don't run the AX path from a debug build on someone
  else's Mac; the window list (`CGWindowListCopyWindowInfo`) is enough to confirm the panel showed
  and at what level and frame.
- **A wavy mask over a fixed-height gradient reads as sand dunes, not flames.** Size the gradient
  to the flame height every frame so the colour fades to clear exactly at the tips, and sharpen
  the wave (raise it to a power) so the crests become tongues.
- **AX coordinates start at the top of the main display** (`CGMainDisplayID`, the menu bar one),
  y down; Cocoa's start at its bottom, y up. `primaryHeight - y - height` converts; a screen above
  the main one gives negative AX y. Set `AXUIElementSetMessagingTimeout` low: a hung app otherwise
  blocks the lookup for six seconds.
- **`CADisplayLink` on macOS 14+** comes from `NSView.displayLink(target:selector:)` and retains its
  target until invalidated; stop it whenever the glow isn't listening.
- **`swift test` needs the Testing plugin path** with only the Command Line Tools:
  `swift test -Xswiftc -plugin-path -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing`.
