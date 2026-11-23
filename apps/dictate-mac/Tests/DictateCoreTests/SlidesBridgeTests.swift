import Foundation
import Testing
@testable import DictateCore

// docs/PLAN-slides.md R11: slides on the external display, presenter view on the laptop.

@Suite struct SlidesBridgeTests {
    @Test func knowsTheSlidesWindowAndNothingElse() {
        #expect(SlidesBridge.isSlidesWindow(URL(string: "about:blank#hotsauce-slides")))
        #expect(!SlidesBridge.isSlidesWindow(URL(string: "about:blank")))
        #expect(!SlidesBridge.isSlidesWindow(URL(string: "https://example.com/#hotsauce-slides")))
        #expect(!SlidesBridge.isSlidesWindow(nil))
    }

    @Test func tellsThePageHowManyDisplays() {
        #expect(SlidesBridge.displaysScript(count: 2) == "window.hotsauceMacDisplays = 2")
        #expect(SlidesBridge.displaysScript(count: 0) == "window.hotsauceMacDisplays = 1")
    }

    @Test func readsFullScreenAsksOnly() {
        #expect(SlidesBridge.parse(["fullScreen": true] as [String: Any]) == .fullScreen(true))
        #expect(SlidesBridge.parse(["fullScreen": false] as [String: Any]) == .fullScreen(false))
        #expect(SlidesBridge.parse(["fullScreen": "yes"] as [String: Any]) == nil)
        #expect(SlidesBridge.parse("fullScreen") == nil)
        #expect(SlidesBridge.parse(nil) == nil)
    }
}
