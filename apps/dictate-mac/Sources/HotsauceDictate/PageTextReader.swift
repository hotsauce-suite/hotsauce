import CoreGraphics
import DictateCore
import Foundation
import ImageIO
import Vision

/// Make searchable in PDF tools (docs/PLAN-pdf-tools.md R6): Vision reads a page picture the page
/// sends, and answers with each line and where it sits.
enum PageTextReader {
    nonisolated static func read(_ png: Data) -> [TextReading.Line]? {
        guard let source = CGImageSourceCreateWithData(png as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              TextReading.fits(width: width, height: height),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { return nil }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.automaticallyDetectsLanguage = true
        do {
            try VNImageRequestHandler(cgImage: image).perform([request])
        } catch {
            return nil
        }
        return (request.results ?? []).compactMap { observation in
            guard let text = observation.topCandidates(1).first?.string else { return nil }
            return TextReading.Line(text: text, box: observation.boundingBox)
        }
    }
}
