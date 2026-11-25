import Foundation
import Testing
@testable import DictateCore

// docs/PLAN-dictate-punctuation-and-fixes.md, H6: the same fixes as the server, offline.
@Suite struct WordFixesTests {
    private let fixes = [WordFix(heard: "Rajeev", write: "Rajiv"), WordFix(heard: "hot sauce", write: "Hotsauce")]

    @Test func writesEachHeardSpellingAsItsWord() {
        #expect(WordFixes.apply("rajeev's notes for RAJEEV and Rajeevan", fixes) == "Rajiv's notes for Rajiv and Rajeevan")
        #expect(WordFixes.apply("Open hot  sauce dictate", fixes) == "Open Hotsauce dictate")
        #expect(WordFixes.apply("nothing here", []) == "nothing here")
    }

    @Test func prefersTheLongerSpellingAndNeverChains() {
        let chained = [
            WordFix(heard: "raj", write: "Raj K"),
            WordFix(heard: "raj eev", write: "Rajiv"),
            WordFix(heard: "Rajiv", write: "nope"),
        ]
        #expect(WordFixes.apply("ask raj eev and raj", chained) == "ask Rajiv and Raj K")
    }

    @Test func keepsTheListOnThisMacUntilForgotten() throws {
        let defaults = try #require(UserDefaults(suiteName: "WordFixesTests"))
        defaults.removePersistentDomain(forName: "WordFixesTests")
        #expect(WordFixes.cached(defaults).isEmpty)
        WordFixes.save(fixes, in: defaults)
        #expect(WordFixes.cached(defaults) == fixes)
        WordFixes.forget(defaults)
        #expect(WordFixes.cached(defaults).isEmpty)
    }

    @Test func readsTheFixesTheServerSends() throws {
        let body = #"{"mine":["Rajiv"],"team":[],"fixes":[{"heard":"Rajeev","write":"Rajiv"}],"account":"a@x.test"}"#
        let words = try JSONDecoder().decode(DictationClient.Words.self, from: Data(body.utf8))
        #expect(words.fixes == [WordFix(heard: "Rajeev", write: "Rajiv")])
        let old = try JSONDecoder().decode(DictationClient.Words.self, from: Data(#"{"mine":[],"team":[]}"#.utf8))
        #expect(old.fixes == nil)
    }
}
