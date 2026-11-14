import Testing
@testable import DictateCore

@Suite struct PermissionCheckTests {
    private func snapshot(
        microphone: Bool = true, accessibility: Bool = true, location: Bool = true,
        notifications: Bool = true, notificationsNeeded: Bool = true
    ) -> PermissionCheck.Snapshot {
        .init(microphone: microphone, accessibility: accessibility, location: location,
              notifications: notifications, notificationsNeeded: notificationsNeeded)
    }

    @Test func nothingIsMissingWhenEverythingIsGranted() {
        #expect(PermissionCheck.missing(snapshot()).isEmpty)
    }

    @Test func listsEachMissingPermissionInWindowOrder() {
        let all = snapshot(microphone: false, accessibility: false, location: false, notifications: false)
        #expect(PermissionCheck.missing(all) == [.microphone, .accessibility, .location, .notifications])
        #expect(PermissionCheck.missing(snapshot(location: false)) == [.location])
        #expect(PermissionCheck.missing(snapshot(accessibility: false)) == [.accessibility])
    }

    @Test func notificationsCountOnlyWhenSomethingUsesThem() {
        #expect(PermissionCheck.missing(snapshot(notifications: false, notificationsNeeded: false)).isEmpty)
        #expect(PermissionCheck.missing(snapshot(notifications: false, notificationsNeeded: true)) == [.notifications])
    }

    @Test func showsOnFirstLaunchAndWheneverSomethingIsMissing() {
        #expect(PermissionCheck.showAtLaunch(hasOnboarded: false, missing: []))
        #expect(PermissionCheck.showAtLaunch(hasOnboarded: true, missing: [.location]))
        #expect(PermissionCheck.showAtLaunch(hasOnboarded: true, missing: [.microphone, .notifications]))
        #expect(!PermissionCheck.showAtLaunch(hasOnboarded: true, missing: []))
    }

    @Test func everyCombinationShowsTheWindowExactlyWhenSomethingIsMissing() {
        for bits in 0..<32 {
            let s = snapshot(
                microphone: bits & 1 != 0, accessibility: bits & 2 != 0, location: bits & 4 != 0,
                notifications: bits & 8 != 0, notificationsNeeded: bits & 16 != 0
            )
            let anyMissing = !s.microphone || !s.accessibility || !s.location || (s.notificationsNeeded && !s.notifications)
            #expect(PermissionCheck.showAtLaunch(hasOnboarded: true, missing: PermissionCheck.missing(s)) == anyMissing)
        }
    }
}
