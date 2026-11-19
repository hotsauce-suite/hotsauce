import CoreGraphics
import Foundation
import ImageIO
import Testing
@testable import DictateCore

// docs/PLAN-screenshots.md R11 to R13 (slice 3, the editor).

@Suite struct ShotDocumentTests {
    let ember = ShotPalette.defaultColor
    let blue = ShotPalette.colors[4].color

    func document() -> ShotDocument { ShotDocument(sourceWidth: 800, sourceHeight: 600) }

    @Test func layersGetIdsAndStayInOrder() {
        var d = document()
        let a = d.add(.rectangle(CGRect(x: 10, y: 10, width: 50, height: 40)), color: ember, width: 6)
        let b = d.add(.arrow(from: .zero, to: CGPoint(x: 100, y: 0)), color: ember, width: 6)
        #expect(a != b)
        #expect(d.layers.map(\.id) == [a, b])
        #expect(d.isEdited)
        #expect(!document().isEdited)
    }

    @Test func stepsNumberThemselvesAndCloseGapsOnDelete() {
        var d = document()
        let one = d.add(.step(center: CGPoint(x: 10, y: 10), radius: 20, number: 0), color: ember, width: 6)
        d.add(.rectangle(CGRect(x: 0, y: 0, width: 10, height: 10)), color: ember, width: 6)
        let two = d.add(.step(center: CGPoint(x: 50, y: 10), radius: 20, number: 0), color: ember, width: 6)
        let three = d.add(.step(center: CGPoint(x: 90, y: 10), radius: 20, number: 0), color: ember, width: 6)
        func numbers() -> [Int] { d.layers.compactMap { if case let .step(_, _, n) = $0.shape { n } else { nil } } }
        #expect(numbers() == [1, 2, 3])
        #expect(d.nextStepNumber == 4)
        d.delete([one])
        #expect(numbers() == [1, 2])
        #expect(d.layer(two).map { if case let .step(_, _, n) = $0.shape { n } else { 0 } } == 1)
        let copies = d.duplicate([three])
        #expect(numbers() == [1, 2, 3])
        #expect(copies.count == 1)
    }

    @Test func movesNudgesAndDuplicates() {
        var d = document()
        let id = d.add(.ellipse(CGRect(x: 10, y: 10, width: 50, height: 40)), color: ember, width: 6)
        d.move([id], by: CGVector(dx: 5, dy: -3))
        #expect(d.layer(id)?.shape == .ellipse(CGRect(x: 15, y: 7, width: 50, height: 40)))
        d.nudge([id], dx: 1, dy: 0, shift: false)
        d.nudge([id], dx: 0, dy: 1, shift: true)
        #expect(d.layer(id)?.shape == .ellipse(CGRect(x: 16, y: 17, width: 50, height: 40)))
        let copy = d.duplicate([id])
        let copyID = try? #require(copy.first)
        #expect(d.layer(copyID ?? -1)?.shape == .ellipse(CGRect(x: 36, y: 37, width: 50, height: 40)))
        #expect(d.layers.count == 2)
    }

    @Test func recolourAndWidthChangeOnlyTheChosenLayers() {
        var d = document()
        let a = d.add(.rectangle(CGRect(x: 0, y: 0, width: 10, height: 10)), color: ember, width: 6)
        let b = d.add(.rectangle(CGRect(x: 0, y: 0, width: 10, height: 10)), color: ember, width: 6)
        d.setColor([a], blue)
        d.setWidth([a], 10)
        #expect(d.layer(a)?.color == blue && d.layer(a)?.width == 10)
        #expect(d.layer(b)?.color == ember && d.layer(b)?.width == 6)
        #expect(d.allIDs == [a, b])
    }

    @Test func cropIsWholePixelsInsideTheCapture() {
        var d = document()
        d.setCrop(CGRect(x: 10.4, y: -5, width: 100.2, height: 50.5))
        #expect(d.crop == CGRect(x: 10, y: 0, width: 101, height: 46))
        #expect(d.visibleRect == d.crop)
        d.setCrop(d.sourceBounds)
        #expect(d.crop == nil)
        d.setCrop(CGRect(x: 900, y: 900, width: 10, height: 10))
        #expect(d.crop == nil)
    }

    @Test func layersSurviveAJSONRoundTrip() throws {
        var d = document()
        d.add(.text(origin: CGPoint(x: 3, y: 4), string: "Hi\nthere", fontSize: 32), color: ember, width: 6)
        d.add(.highlighter(points: [.zero, CGPoint(x: 5, y: 5)]), color: ember, width: 6)
        d.add(.redact(CGRect(x: 1, y: 2, width: 3, height: 4)), color: ember, width: 6)
        d.setCrop(CGRect(x: 1, y: 1, width: 20, height: 20))
        let back = try JSONDecoder().decode(ShotDocument.self, from: JSONEncoder().encode(d))
        #expect(back == d)
    }
}

@Suite struct ShotToolTests {
    @Test func everyToolHasItsKeyAndATooltip() {
        #expect(ShotTool.forKey("A") == .arrow)
        #expect(ShotTool.forKey("x") == .redact)
        #expect(ShotTool.forKey("z") == nil)
        #expect(ShotTool.arrow.tooltip == "Arrow (A)")
        #expect(Set(ShotTool.allCases.map(\.key)).count == ShotTool.allCases.count)
    }
}

@Suite struct ShotGeometryTests {
    let ember = ShotPalette.defaultColor

    @Test func hitTestingFindsTheTopmostLayer() {
        var d = ShotDocument(sourceWidth: 800, sourceHeight: 600)
        let back = d.add(.rectangle(CGRect(x: 0, y: 0, width: 200, height: 200)), color: ember, width: 6)
        let front = d.add(.ellipse(CGRect(x: 50, y: 50, width: 100, height: 100)), color: ember, width: 6)
        #expect(ShotGeometry.layer(at: CGPoint(x: 100, y: 100), in: d, tolerance: 4)?.id == front)
        // Inside the ellipse's box but outside the ellipse: the rectangle behind.
        #expect(ShotGeometry.layer(at: CGPoint(x: 53, y: 53), in: d, tolerance: 0)?.id == back)
        #expect(ShotGeometry.layer(at: CGPoint(x: 400, y: 400), in: d, tolerance: 4) == nil)
    }

    @Test func arrowsAndHighlightsAreHitNearTheirLine() {
        let arrow = ShotLayer(id: 1, shape: .arrow(from: CGPoint(x: 0, y: 0), to: CGPoint(x: 100, y: 0)), color: ember, width: 4)
        #expect(arrow.contains(CGPoint(x: 50, y: 6), tolerance: 4))
        #expect(!arrow.contains(CGPoint(x: 50, y: 40), tolerance: 4))
        #expect(!arrow.contains(CGPoint(x: 150, y: 0), tolerance: 4))
        let highlight = ShotLayer(id: 2, shape: .highlighter(points: [.zero, CGPoint(x: 100, y: 0), CGPoint(x: 100, y: 100)]), color: ember, width: 6)
        #expect(highlight.contains(CGPoint(x: 105, y: 60), tolerance: 0))
        #expect(!highlight.contains(CGPoint(x: 50, y: 50), tolerance: 4))
    }

    @Test func stepsAndTextAreHitInsideTheirShape() {
        let step = ShotLayer(id: 1, shape: .step(center: CGPoint(x: 50, y: 50), radius: 20, number: 1), color: ember, width: 6)
        #expect(step.contains(CGPoint(x: 64, y: 64), tolerance: 0))
        #expect(!step.contains(CGPoint(x: 70, y: 70), tolerance: 0))
        let text = ShotLayer(id: 2, shape: .text(origin: CGPoint(x: 10, y: 10), string: "Hello", fontSize: 40), color: ember, width: 6)
        #expect(text.bounds.width > 60 && text.bounds.height >= 40)
        #expect(text.contains(CGPoint(x: 20, y: 30), tolerance: 0))
        #expect(!text.contains(CGPoint(x: 5, y: 5), tolerance: 0))
    }

    @Test func handlesAreFoundWithinTolerance() {
        let rect = ShotLayer(id: 1, shape: .rectangle(CGRect(x: 100, y: 100, width: 200, height: 100)), color: ember, width: 6)
        #expect(rect.handles.count == 8)
        #expect(ShotGeometry.handle(at: CGPoint(x: 302, y: 198), of: rect, tolerance: 5) == .bottomRight)
        #expect(ShotGeometry.handle(at: CGPoint(x: 200, y: 97), of: rect, tolerance: 5) == .top)
        #expect(ShotGeometry.handle(at: CGPoint(x: 200, y: 150), of: rect, tolerance: 5) == nil)
        let arrow = ShotLayer(id: 2, shape: .arrow(from: CGPoint(x: 10, y: 10), to: CGPoint(x: 90, y: 50)), color: ember, width: 6)
        #expect(arrow.handles == [.start, .end])
        #expect(ShotGeometry.handle(at: CGPoint(x: 88, y: 52), of: arrow, tolerance: 5) == .end)
        let step = ShotLayer(id: 3, shape: .step(center: .zero, radius: 10, number: 1), color: ember, width: 6)
        #expect(step.handles.count == 4)
    }

    let box = CGRect(x: 100, y: 100, width: 200, height: 100)

    @Test func everyHandleKeepsTheOppositeSideFixed() {
        #expect(ShotGeometry.resize(box, .bottomRight, to: CGPoint(x: 400, y: 250), constraint: .free, minSize: 4) == CGRect(x: 100, y: 100, width: 300, height: 150))
        #expect(ShotGeometry.resize(box, .topLeft, to: CGPoint(x: 50, y: 80), constraint: .free, minSize: 4) == CGRect(x: 50, y: 80, width: 250, height: 120))
        #expect(ShotGeometry.resize(box, .right, to: CGPoint(x: 350, y: 999), constraint: .free, minSize: 4) == CGRect(x: 100, y: 100, width: 250, height: 100))
        #expect(ShotGeometry.resize(box, .top, to: CGPoint(x: 999, y: 150), constraint: .free, minSize: 4) == CGRect(x: 100, y: 150, width: 200, height: 50))
        #expect(ShotGeometry.resize(box, .left, to: CGPoint(x: 120, y: 0), constraint: .free, minSize: 4) == CGRect(x: 120, y: 100, width: 180, height: 100))
        #expect(ShotGeometry.resize(box, .bottomLeft, to: CGPoint(x: 90, y: 210), constraint: .free, minSize: 4) == CGRect(x: 90, y: 100, width: 210, height: 110))
    }

    @Test func aHandleCannotPassTheOppositeSide() {
        #expect(ShotGeometry.resize(box, .right, to: CGPoint(x: 0, y: 0), constraint: .free, minSize: 4) == CGRect(x: 100, y: 100, width: 4, height: 100))
        #expect(ShotGeometry.resize(box, .topLeft, to: CGPoint(x: 900, y: 900), constraint: .free, minSize: 10) == CGRect(x: 290, y: 190, width: 10, height: 10))
    }

    @Test func shiftMakesASquareAndTextScalesEvenly() {
        #expect(ShotGeometry.resize(box, .bottomRight, to: CGPoint(x: 400, y: 150), constraint: .square, minSize: 4) == CGRect(x: 100, y: 100, width: 300, height: 300))
        #expect(ShotGeometry.resize(box, .topLeft, to: CGPoint(x: 0, y: 90), constraint: .square, minSize: 4) == CGRect(x: 0, y: -100, width: 300, height: 300))
        // 2:1 kept.
        #expect(ShotGeometry.resize(box, .bottomRight, to: CGPoint(x: 500, y: 150), constraint: .proportional, minSize: 4) == CGRect(x: 100, y: 100, width: 400, height: 200))
        #expect(ShotGeometry.dragRect(from: CGPoint(x: 10, y: 10), to: CGPoint(x: 0, y: 40), square: true) == CGRect(x: -20, y: 10, width: 30, height: 30))
    }

    @Test func zeroWidthOrHeightBoxesResizeToFiniteNumbers() {
        let vertical = ShotLayer(id: 1, shape: .highlighter(points: [CGPoint(x: 10, y: 0), CGPoint(x: 10, y: 100)]), color: ember, width: 6)
        for handle in ShotHandle.allCases {
            let resized = vertical.resized(handle, to: CGPoint(x: 60, y: 140), shift: true)
            guard case let .highlighter(points) = resized.shape else { Issue.record("highlighter"); continue }
            #expect(points.allSatisfy { $0.x.isFinite && $0.y.isFinite })
        }
        let flat = CGRect(x: 0, y: 0, width: 100, height: 0)
        for constraint in [ShotConstraint.free, .square, .proportional] {
            let r = ShotGeometry.resize(flat, .bottomRight, to: CGPoint(x: 120, y: 30), constraint: constraint, minSize: 1)
            #expect(r.width.isFinite && r.height.isFinite && r.minX.isFinite && r.minY.isFinite)
        }
    }

    @Test func aFreshCropGrowsWhicheverWayItIsDragged() {
        let bounds = CGRect(x: 0, y: 0, width: 400, height: 300)
        let anchor = CGPoint(x: 200, y: 150)
        #expect(ShotGeometry.cropRect(from: anchor, to: CGPoint(x: 100, y: 50), square: false, in: bounds) == CGRect(x: 100, y: 50, width: 100, height: 100))
        #expect(ShotGeometry.cropRect(from: anchor, to: CGPoint(x: 300, y: 50), square: false, in: bounds) == CGRect(x: 200, y: 50, width: 100, height: 100))
        #expect(ShotGeometry.cropRect(from: anchor, to: CGPoint(x: 100, y: 250), square: false, in: bounds) == CGRect(x: 100, y: 150, width: 100, height: 100))
        // Past the capture's edge: clamped to it.
        #expect(ShotGeometry.cropRect(from: anchor, to: CGPoint(x: -50, y: 999), square: false, in: bounds) == CGRect(x: 0, y: 150, width: 200, height: 150))
        // Starting outside: from the nearest edge.
        #expect(ShotGeometry.cropRect(from: CGPoint(x: -20, y: -20), to: CGPoint(x: 50, y: 40), square: false, in: bounds) == CGRect(x: 0, y: 0, width: 50, height: 40))
        #expect(ShotGeometry.cropRect(from: anchor, to: CGPoint(x: 150, y: 140), square: true, in: bounds) == CGRect(x: 150, y: 100, width: 50, height: 50))
    }

    @Test func arrowsSnapTo45Degrees() {
        let snapped = ShotGeometry.snap45(from: .zero, to: CGPoint(x: 100, y: 10))
        #expect(abs(snapped.y) < 0.001 && abs(snapped.x - hypot(100, 10)) < 0.001)
        let diagonal = ShotGeometry.snap45(from: .zero, to: CGPoint(x: 100, y: 80))
        #expect(abs(diagonal.x - diagonal.y) < 0.001)
        let arrow = ShotLayer(id: 1, shape: .arrow(from: .zero, to: CGPoint(x: 50, y: 0)), color: ember, width: 6)
        if case let .arrow(_, to) = arrow.resized(.end, to: CGPoint(x: 3, y: 90), shift: true).shape {
            #expect(abs(to.x) < 0.001 && to.y > 89)
        } else { Issue.record("not an arrow") }
    }

    @Test func resizingEachKindOfLayer() {
        let text = ShotLayer(id: 1, shape: .text(origin: CGPoint(x: 10, y: 10), string: "Hi", fontSize: 20), color: ember, width: 6)
        let bigger = text.resized(.bottomRight, to: CGPoint(x: text.bounds.maxX + 100, y: text.bounds.maxY + 100), shift: false)
        guard case let .text(origin, _, size) = bigger.shape else { Issue.record("text"); return }
        #expect(size > 20)
        #expect(origin == CGPoint(x: 10, y: 10))
        let tiny = text.resized(.bottomRight, to: CGPoint(x: 0, y: 0), shift: false)
        if case let .text(_, _, size) = tiny.shape { #expect(size >= 8) }

        let step = ShotLayer(id: 2, shape: .step(center: CGPoint(x: 50, y: 50), radius: 20, number: 3), color: ember, width: 6)
        if case let .step(center, radius, number) = step.resized(.bottomRight, to: CGPoint(x: 90, y: 90), shift: false).shape {
            #expect(radius == 30 && center == CGPoint(x: 60, y: 60) && number == 3)
        } else { Issue.record("step") }

        let highlight = ShotLayer(id: 3, shape: .highlighter(points: [CGPoint(x: 0, y: 0), CGPoint(x: 100, y: 50)]), color: ember, width: 6)
        #expect(highlight.resized(.bottomRight, to: CGPoint(x: 200, y: 100), shift: false).shape == .highlighter(points: [.zero, CGPoint(x: 200, y: 100)]))
    }

    @Test func dragsMakeShapesAndTinyDragsMakeNothing() {
        #expect(ShotGeometry.shape(for: .rectangle, from: .zero, to: CGPoint(x: 2, y: 2), shift: false) == nil)
        #expect(ShotGeometry.shape(for: .ellipse, from: .zero, to: CGPoint(x: 30, y: 10), shift: true) == .ellipse(CGRect(x: 0, y: 0, width: 30, height: 30)))
        #expect(ShotGeometry.shape(for: .redact, from: CGPoint(x: 0.5, y: 0.5), to: CGPoint(x: 10.2, y: 10.2), shift: false) == .redact(CGRect(x: 0, y: 0, width: 11, height: 11)))
        #expect(ShotGeometry.shape(for: .arrow, from: .zero, to: CGPoint(x: 3, y: 3), shift: false) == nil)
        #expect(ShotGeometry.shape(for: .highlighter, from: .zero, to: CGPoint(x: 40, y: 40), shift: true) == .highlighter(points: [.zero, CGPoint(x: 40, y: 40)]))
        #expect(ShotGeometry.shape(for: .select, from: .zero, to: CGPoint(x: 40, y: 40), shift: false) == nil)
    }
}

@Suite struct ShotHistoryTests {
    let ember = ShotPalette.defaultColor

    /// A made-up sequence of edits, driven by a seed, recorded as the editor records them.
    func randomEdits(seed: UInt64, count: Int) -> (snapshots: [ShotDocument], history: ShotHistory, final: ShotDocument) {
        var generator = SeededGenerator(seed: seed)
        var d = ShotDocument(sourceWidth: 500, sourceHeight: 400)
        var history = ShotHistory()
        var snapshots = [d]
        for _ in 0..<count {
            history.record(d)
            let ids = Array(d.allIDs)
            switch Int.random(in: 0..<7, using: &generator) {
            case 0, 1:
                d.add(.rectangle(CGRect(x: .random(in: 0..<400, using: &generator), y: 10, width: 20, height: 20)), color: ember, width: 6)
            case 2: d.add(.step(center: CGPoint(x: 5, y: 5), radius: 10, number: 0), color: ember, width: 6)
            case 3: if let id = ids.randomElement(using: &generator) { d.delete([id]) } else { d.add(.ellipse(.zero), color: ember, width: 3) }
            case 4: d.move(Set(ids), by: CGVector(dx: 3, dy: 1))
            case 5: d.setCrop(CGRect(x: 0, y: 0, width: .random(in: 10..<400, using: &generator), height: 100))
            default: d.setColor(Set(ids), ShotPalette.colors[2].color)
            }
            snapshots.append(d)
        }
        return (snapshots, history, d)
    }

    @Test(arguments: [1, 2, 3, 42, 99] as [UInt64])
    func undoWalksBackThroughEveryStateAndRedoForward(seed: UInt64) {
        var (snapshots, history, current) = randomEdits(seed: seed, count: 40)
        for expected in snapshots.reversed().dropFirst() {
            current = history.undo(current)!
            #expect(current == expected)
        }
        #expect(!history.canUndo)
        for expected in snapshots.dropFirst() {
            current = history.redo(current)!
            #expect(current == expected)
        }
        #expect(!history.canRedo)
    }

    @Test func aKeyEditDuringADragKeepsBothStepsInOrder() {
        var history = ShotHistory()
        let start = ShotDocument(sourceWidth: 100, sourceHeight: 100)
        var d = start
        let id = d.add(.rectangle(CGRect(x: 0, y: 0, width: 10, height: 10)), color: ember, width: 1)
        let added = d
        history.record(start)
        // A drag starts and moves the box live.
        history.beginGesture(d)
        d.move([id], by: CGVector(dx: 5, dy: 0))
        let dragged = d
        // Delete pressed mid-drag: an ordinary change.
        history.record(d)
        d.delete([id])
        // The drag ends after the delete; nothing more to record.
        history.endGesture(d)
        d = history.undo(d)!
        #expect(d == dragged)
        d = history.undo(d)!
        #expect(d == added)
        d = history.undo(d)!
        #expect(d == start)
        #expect(!history.canUndo)
    }

    @Test func aGestureIsOneStepAndAnEmptyOneIsNone() {
        var history = ShotHistory()
        var d = ShotDocument(sourceWidth: 100, sourceHeight: 100)
        let id = d.add(.rectangle(CGRect(x: 0, y: 0, width: 10, height: 10)), color: ember, width: 1)
        let before = d
        history.beginGesture(d)
        for _ in 0..<10 { d.move([id], by: CGVector(dx: 1, dy: 1)) }
        history.endGesture(d)
        history.beginGesture(d)
        history.endGesture(d) // a click that moved nothing
        #expect(history.undo(d) == before)
        #expect(!history.canUndo)
    }

    @Test func undoMidGestureEndsItFirst() {
        var history = ShotHistory()
        var d = ShotDocument(sourceWidth: 100, sourceHeight: 100)
        let id = d.add(.rectangle(CGRect(x: 0, y: 0, width: 10, height: 10)), color: ember, width: 1)
        let before = d
        history.beginGesture(d)
        d.move([id], by: CGVector(dx: 7, dy: 0))
        let moved = d
        d = history.undo(d)!
        #expect(d == before)
        #expect(history.redo(d) == moved)
    }

    @Test func aNewEditDropsTheRedoStack() {
        var history = ShotHistory()
        var d = ShotDocument(sourceWidth: 10, sourceHeight: 10)
        history.record(d)
        d.add(.rectangle(.zero), color: ember, width: 1)
        d = history.undo(d)!
        #expect(history.canRedo)
        history.record(d)
        #expect(!history.canRedo)
    }

    @Test func historyIsCapped() {
        var history = ShotHistory(cap: 3)
        var d = ShotDocument(sourceWidth: 10, sourceHeight: 10)
        for _ in 0..<10 {
            history.record(d)
            d.add(.rectangle(.zero), color: ember, width: 1)
        }
        var undone = 0
        while let previous = history.undo(d) { d = previous; undone += 1 }
        #expect(undone == 3)
        #expect(d.layers.count == 7)
    }
}

struct SeededGenerator: RandomNumberGenerator {
    var state: UInt64
    init(seed: UInt64) { state = seed &+ 0x9E37_79B9_7F4A_7C15 }
    mutating func next() -> UInt64 {
        state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        return state ^ (state >> 29)
    }
}

@Suite struct ShotViewTransformTests {
    let content = CGRect(x: 0, y: 0, width: 2000, height: 1000)

    @Test func roundTripsAtAnyZoom() {
        for zoom: CGFloat in [0.1, 0.5, 1, 2.5] {
            let t = ShotViewTransform(content: CGRect(x: 100, y: 50, width: 400, height: 300), zoom: zoom, origin: CGPoint(x: 17, y: 9))
            let p = CGPoint(x: 333, y: 222)
            let back = t.toSource(t.toView(p))
            #expect(abs(back.x - p.x) < 0.0001 && abs(back.y - p.y) < 0.0001)
            #expect(t.toView(CGPoint(x: 100, y: 50)) == CGPoint(x: 17, y: 9))
        }
    }

    @Test func fitsInsideTheViewButNeverPastActualSize() {
        let fit = ShotViewTransform.fitted(content: content, in: CGSize(width: 1040, height: 800), margin: 20, backingScale: 2)
        #expect(fit.zoom == 0.5) // 1000 / 2000, which is also actual size on Retina
        let small = ShotViewTransform.fitted(content: CGRect(x: 0, y: 0, width: 100, height: 100), in: CGSize(width: 1000, height: 800), margin: 20, backingScale: 2)
        #expect(small.zoom == 0.5)
        #expect(small.origin == CGPoint(x: 475, y: 375))
        let narrow = ShotViewTransform.fitted(content: content, in: CGSize(width: 440, height: 800), margin: 20, backingScale: 1)
        #expect(narrow.zoom == 0.2)
    }

    @Test func changingTheContentKeepsZoomAndWhereThingsAre() {
        let t = ShotViewTransform(content: CGRect(x: 100, y: 100, width: 400, height: 300), zoom: 1.5, origin: CGPoint(x: 30, y: 40))
        let wider = t.withContent(CGRect(x: 0, y: 0, width: 2000, height: 1000))
        #expect(wider.zoom == 1.5)
        for p in [CGPoint(x: 100, y: 100), CGPoint(x: 333, y: 250)] {
            let a = t.toView(p), b = wider.toView(p)
            #expect(abs(a.x - b.x) < 0.0001 && abs(a.y - b.y) < 0.0001)
        }
    }

    @Test func actualSizeIsOnePixelPerScreenPixel() {
        #expect(ShotViewTransform.actualSize(content: content, in: CGSize(width: 100, height: 100), backingScale: 2).zoom == 0.5)
        #expect(ShotViewTransform.actualSize(content: content, in: CGSize(width: 100, height: 100), backingScale: 1).zoom == 1)
    }

    @Test func zoomKeepsThePointUnderThePointer() {
        let t = ShotViewTransform(content: content, zoom: 0.5, origin: CGPoint(x: 10, y: 10))
        let anchor = CGPoint(x: 300, y: 200)
        let before = t.toSource(anchor)
        let z = t.zoomed(by: 2, around: anchor)
        #expect(z.zoom == 1)
        let after = z.toSource(anchor)
        #expect(abs(after.x - before.x) < 0.0001 && abs(after.y - before.y) < 0.0001)
        #expect(t.zoomed(by: 1000, around: anchor).zoom == ShotViewTransform.zoomRange.upperBound)
    }
}

@Suite struct TextReadingOrderTests {
    func piece(_ text: String, _ x: CGFloat, _ y: CGFloat, _ w: CGFloat = 50, _ h: CGFloat = 10) -> TextReadingOrder.Piece {
        TextReadingOrder.Piece(text: text, box: CGRect(x: x, y: y, width: w, height: h))
    }

    @Test func readsTopToBottomThenLeftToRight() {
        let pieces = [
            piece("world", 60, 1), piece("Second", 0, 30), piece("Hello", 0, 0), piece("line", 70, 31),
            piece("Third", 0, 60, 50, 14),
        ]
        #expect(TextReadingOrder.text(pieces) == "Hello world\nSecond line\nThird")
    }

    @Test func columnsSideBySideStayOnTheirLines() {
        // A slightly lower right column still reads with its row.
        let pieces = [piece("Name", 0, 0), piece("Value", 200, 3), piece("Alice", 0, 20), piece("42", 200, 22)]
        #expect(TextReadingOrder.text(pieces) == "Name Value\nAlice 42")
    }

    @Test func countsWords() {
        #expect(TextReadingOrder.wordCount("Hello world\nSecond  line") == 4)
        #expect(TextReadingOrder.wordCount("") == 0)
        #expect(TextReadingOrder.text([]) == "")
    }
}

@Suite struct ShotRendererTests {
    /// A width×height image whose pixel (x, y) is `color(x, y)`, row 0 at the top.
    func image(_ width: Int, _ height: Int, _ color: (Int, Int) -> (UInt8, UInt8, UInt8)) throws -> CGImage {
        var bytes = [UInt8](repeating: 255, count: width * height * 4)
        for y in 0..<height {
            for x in 0..<width {
                let c = color(x, y)
                let i = (y * width + x) * 4
                bytes[i] = c.0; bytes[i + 1] = c.1; bytes[i + 2] = c.2
            }
        }
        let context = try #require(CGContext(
            data: &bytes, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        return try #require(context.makeImage())
    }

    /// Decodes a PNG back to RGBA rows, top first.
    func pixels(_ png: Data) throws -> (width: Int, height: Int, bytes: [UInt8]) {
        let source = try #require(CGImageSourceCreateWithData(png as CFData, nil))
        let decoded = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
        var bytes = [UInt8](repeating: 0, count: decoded.width * decoded.height * 4)
        let context = try #require(CGContext(
            data: &bytes, width: decoded.width, height: decoded.height, bitsPerComponent: 8, bytesPerRow: decoded.width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(decoded, in: CGRect(x: 0, y: 0, width: decoded.width, height: decoded.height))
        return (decoded.width, decoded.height, bytes)
    }

    func region(_ p: (width: Int, height: Int, bytes: [UInt8]), _ rect: CGRect) -> [UInt8] {
        var out: [UInt8] = []
        for y in Int(rect.minY)..<Int(rect.maxY) {
            for x in Int(rect.minX)..<Int(rect.maxX) {
                let i = (y * p.width + x) * 4
                out += p.bytes[i..<i + 3]
            }
        }
        return out
    }

    let checker: (Int, Int) -> (UInt8, UInt8, UInt8) = { x, y in (x + y) % 2 == 0 ? (0, 0, 0) : (255, 255, 255) }
    let inverted: (Int, Int) -> (UInt8, UInt8, UInt8) = { x, y in (x + y) % 2 == 0 ? (255, 255, 255) : (0, 0, 0) }
    let stripes: (Int, Int) -> (UInt8, UInt8, UInt8) = { x, _ in x % 3 == 0 ? (250, 10, 10) : (10, 250, 10) }

    @Test func anOpaqueRedactionLeavesNoSourcePixel() throws {
        let area = CGRect(x: 12, y: 12, width: 36, height: 36)
        for pattern in [checker, stripes] {
            let source = try image(60, 60, pattern)
            var d = ShotDocument(sourceWidth: 60, sourceHeight: 60)
            d.add(.redact(area), color: ShotPalette.redactColor, width: 6)
            let out = try pixels(try #require(ShotRenderer.exportPNG(d, source: source)))
            let inside = region(out, area)
            #expect(inside.count == 36 * 36 * 3)
            // Every pixel is exactly the fill: 0x1D1815.
            #expect(stride(from: 0, to: inside.count, by: 3).allSatisfy { inside[$0] == 0x1D && inside[$0 + 1] == 0x18 && inside[$0 + 2] == 0x15 })
            // Outside is untouched.
            let corner = region(out, CGRect(x: 0, y: 0, width: 12, height: 12))
            let expected = (0..<12).flatMap { y in (0..<12).flatMap { x in [pattern(x, y).0, pattern(x, y).1, pattern(x, y).2] } }
            #expect(corner == expected)
        }
    }

    @Test func copyTextSeesRedactionsAndNothingElse() throws {
        var d = ShotDocument(sourceWidth: 60, sourceHeight: 60)
        d.add(.arrow(from: .zero, to: CGPoint(x: 50, y: 50)), color: ShotPalette.defaultColor, width: 6)
        d.add(.redact(CGRect(x: 10, y: 10, width: 20, height: 20)), color: ShotPalette.redactColor, width: 6)
        d.setCrop(CGRect(x: 5, y: 5, width: 40, height: 40))
        let masked = d.redactionsOnly
        #expect(masked.layers.count == 1)
        #expect(masked.layers.first?.shape == .redact(CGRect(x: 10, y: 10, width: 20, height: 20)))
        #expect(masked.crop == d.crop)
        let out = try pixels(try #require(ShotRenderer.exportPNG(masked, source: try image(60, 60, checker))))
        let inside = region(out, CGRect(x: 5, y: 5, width: 20, height: 20))
        #expect(stride(from: 0, to: inside.count, by: 3).allSatisfy { inside[$0] == 0x1D })
    }

    @Test func aRedactionOverFractionalPixelsCoversTheWholePixels() throws {
        let source = try image(20, 20, checker)
        var d = ShotDocument(sourceWidth: 20, sourceHeight: 20)
        d.add(.redact(CGRect(x: 4.5, y: 4.5, width: 5, height: 5)), color: ShotPalette.redactColor, width: 6)
        let out = try pixels(try #require(ShotRenderer.exportPNG(d, source: source)))
        let inside = region(out, CGRect(x: 4, y: 4, width: 6, height: 6))
        #expect(stride(from: 0, to: inside.count, by: 3).allSatisfy { inside[$0] == 0x1D })
    }

    @Test func exportsAtTheCropsPixelSize() throws {
        let source = try image(60, 40, stripes)
        var d = ShotDocument(sourceWidth: 60, sourceHeight: 40)
        d.setCrop(CGRect(x: 10, y: 5, width: 30, height: 20))
        let out = try pixels(try #require(ShotRenderer.exportPNG(d, source: source)))
        #expect(out.width == 30 && out.height == 20)
        // Its first pixel is source pixel (10, 5).
        #expect(Array(out.bytes[0..<3]) == [stripes(10, 5).0, stripes(10, 5).1, stripes(10, 5).2])
    }

    @Test func thePNGCarriesNoTextThumbnailOrExif() throws {
        let source = try image(20, 20, checker)
        let png = try #require(ShotRenderer.exportPNG(ShotDocument(sourceWidth: 20, sourceHeight: 20), source: source))
        var chunks: [String] = []
        var offset = 8
        let bytes = [UInt8](png)
        while offset + 8 <= bytes.count {
            let length = Int(bytes[offset]) << 24 | Int(bytes[offset + 1]) << 16 | Int(bytes[offset + 2]) << 8 | Int(bytes[offset + 3])
            chunks.append(String(decoding: bytes[offset + 4..<offset + 8], as: UTF8.self))
            offset += 12 + length
        }
        #expect(chunks.first == "IHDR" && chunks.last == "IEND")
        for forbidden in ["tEXt", "iTXt", "zTXt", "eXIf", "tIME"] { #expect(!chunks.contains(forbidden)) }
    }

    @Test func layersAppearInTheExport() throws {
        let source = try image(100, 100) { _, _ in (255, 255, 255) }
        var d = ShotDocument(sourceWidth: 100, sourceHeight: 100)
        d.add(.rectangle(CGRect(x: 10, y: 10, width: 50, height: 50)), color: ShotPalette.colors[4].color, width: 6)
        let out = try pixels(try #require(ShotRenderer.exportPNG(d, source: source)))
        // On the top edge of the rectangle: blue. In its middle: still white.
        #expect(region(out, CGRect(x: 30, y: 10, width: 1, height: 1)) == [0x0A, 0x84, 0xFF])
        #expect(region(out, CGRect(x: 35, y: 35, width: 1, height: 1)) == [255, 255, 255])
    }
}

@Suite struct RecentCapturesUpdateTests {
    struct Item: Equatable { var id: Int; var name: String }

    @Test func aSavedAsCaptureIsUpdatedInPlace() {
        var recent = RecentCaptures<Item>()
        recent.add(Item(id: 1, name: "a"))
        recent.add(Item(id: 2, name: "b"))
        recent.update(where: { $0.id == 1 }) { $0.name = "renamed" }
        #expect(recent.items == [Item(id: 2, name: "b"), Item(id: 1, name: "renamed")])
        recent.update(where: { $0.id == 9 }) { $0.name = "nothing" }
        #expect(recent.items.count == 2)
    }
}

@Suite struct RedactionEdgeTests {
    func image(_ width: Int, _ height: Int) throws -> CGImage {
        var bytes = [UInt8](repeating: 255, count: width * height * 4)
        for i in stride(from: 0, to: bytes.count, by: 4) { bytes[i] = UInt8((i / 4) % 251); bytes[i + 1] = UInt8((i / 4) % 7 * 30) }
        let context = try #require(CGContext(
            data: &bytes, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        return try #require(context.makeImage())
    }

    /// Every exported pixel inside `rect` (export coordinates) is the redaction fill, 0x1D1815.
    func allFill(_ png: Data, _ rect: CGRect) throws -> Bool {
        let source = try #require(CGImageSourceCreateWithData(png as CFData, nil))
        let decoded = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
        var bytes = [UInt8](repeating: 0, count: decoded.width * decoded.height * 4)
        let context = try #require(CGContext(
            data: &bytes, width: decoded.width, height: decoded.height, bitsPerComponent: 8, bytesPerRow: decoded.width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(decoded, in: CGRect(x: 0, y: 0, width: decoded.width, height: decoded.height))
        let clipped = rect.intersection(CGRect(x: 0, y: 0, width: decoded.width, height: decoded.height))
        for y in Int(clipped.minY)..<Int(clipped.maxY) {
            for x in Int(clipped.minX)..<Int(clipped.maxX) {
                let i = (y * decoded.width + x) * 4
                if bytes[i] != 0x1D || bytes[i + 1] != 0x18 || bytes[i + 2] != 0x15 { return false }
            }
        }
        return true
    }

    @Test func aRedactionAcrossTheCropEdgeCoversItsPartInTheExport() throws {
        var d = ShotDocument(sourceWidth: 80, sourceHeight: 60)
        d.add(.redact(CGRect(x: 30, y: 20, width: 40, height: 30)), color: ShotPalette.redactColor, width: 6)
        d.setCrop(CGRect(x: 10, y: 10, width: 40, height: 30))
        let png = try #require(ShotRenderer.exportPNG(d, source: try image(80, 60)))
        // In the export, the redaction runs from (20, 10) to the crop's right and bottom edges.
        #expect(try allFill(png, CGRect(x: 20, y: 10, width: 20, height: 20)))
    }

    @Test func aRedactionOffTheImageEdgeAndOverlappingOnesAreAllFill() throws {
        var d = ShotDocument(sourceWidth: 50, sourceHeight: 50)
        d.add(.redact(CGRect(x: 30, y: -10, width: 40, height: 30)), color: ShotPalette.redactColor, width: 6)
        d.add(.redact(CGRect(x: 10.5, y: 10.5, width: 25, height: 25)), color: ShotPalette.redactColor, width: 6)
        d.add(.redact(CGRect(x: 20, y: 5, width: 20, height: 20)), color: ShotPalette.redactColor, width: 6)
        let png = try #require(ShotRenderer.exportPNG(d, source: try image(50, 50)))
        #expect(try allFill(png, CGRect(x: 30, y: 0, width: 20, height: 20)))
        #expect(try allFill(png, CGRect(x: 10, y: 10, width: 26, height: 26)))
        #expect(try allFill(png, CGRect(x: 20, y: 5, width: 20, height: 20)))
        #expect(try !allFill(png, CGRect(x: 0, y: 40, width: 5, height: 5)))
    }
}
