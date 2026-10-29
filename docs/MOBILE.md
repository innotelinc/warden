# WARDEN Mobile

WARDEN's desktop build is Electron. Neither store accepts a bundled browser
engine, and Electron has no iOS or Android runtime, so the mobile product is a
**Capacitor shell** around WARDEN's own React surfaces with the platform engine
(Android WebView / iOS WKWebView) doing the rendering.

This document is the runbook: what exists now, what the build produces, and the
exact credentials and buttons that only the account owner can supply.

## Scope of this release

**What this is:** WARDEN Mobile, bundle id `us.innotel.warden`, display name
**WARDEN Mobile** — the platform's own engine (Android `WebView`, iOS
`WKWebView`) driven by WARDEN's chrome, not a hand-off to another app's browser.

- **A browser, not a launcher.** Pages render in an engine the app owns and
  surrounds with its own address bar, back, forward, reload and exit. Before
  this, Android handed every address to Chrome Custom Tabs and iOS to
  `SFSafariViewController`: pages opened, but WARDEN had no address bar of its
  own and no idea where the reader had gone. Both surfaces now live in
  `mobile/plugins/warden-browser` (`android/` and `ios/`).
- **Request-level blocking, both platforms.** Android refuses a request in
  `shouldInterceptRequest`; iOS compiles the same rules into a
  `WKContentRuleList`. Same host list on both, and a test compares the two files
  so they cannot drift apart (`tests/mobile-browser.test.ts`).
- **The slot goes too.** A refused ad leaves an empty container that keeps its
  reserved height, which reads as a broken page; a page script removes the
  container and closes the gap, and re-runs as the page changes.
- **The session is not kept.** iOS uses a non-persistent data store; Android has
  no disk cache, refuses third-party cookies and clears cookies, web storage and
  cache when the surface closes.
- No analytics, crash-reporting, advertising or tracking SDKs. No account. No
  in-app purchases. No sensor access.
- Release pipelines for a signed `.aab` and an `.ipa`, plus store metadata and a
  public privacy policy.

**Operator surfaces (see below):** **Scry** reads the page in front of you and
reports its stack, third parties, trackers, forms and endpoints; **Services**
opens Slack, Teams, WhatsApp and the rest in the same WARDEN surface with a
session that survives; **Mail** does the same for a mail provider's web client.

**Not in this release:** tabs (one session per surface), DoH via
`NEDNSProxyProvider` on iOS and `VpnService` on Android (both need an
entitlement and an App Review explanation), and two of the desktop's surfaces
that need a protocol stack a phone build does not carry — the **shell** (a local
PTY, or the system `ssh` client) and the **IMAP/SMTP mail client** with its fraud
check. Genie, the desktop assistant, needs a gateway key the mobile build
deliberately does not store.

## Layout

```
mobile/
  capacitor.config.ts     app id, scheme, platform switches
  src/                    the shell UI (React + Vite)
  android/                generated Gradle project (signed in CI)
  ios/                    generated Xcode project (archive on macOS runners)
  store/android/listing.json, store/ios/listing.json
  ../.github/workflows/mobile-android.yml, mobile-ios.yml, ios-build-status.yml,
  ../.github/workflows/ios-register-device.yml
  ../web/landing/privacy.html   public privacy policy for both listings
```

## Local development

```bash
cd mobile
npm install
npm run build          # typecheck + Vite build into dist/
npx cap sync           # copy dist/ and plugins into both native projects
npx cap open android   # needs Android Studio + SDK
npx cap open ios       # needs macOS + Xcode
```

The web shell alone runs with `npm run dev` in a browser; navigation then opens
a tab instead of the native browser surface. That is expected.

## Release builds

### Android

Play needs two separate credentials, and neither is something automation should
invent: the **upload keystore**, which is the app's signing identity, and a
**service account**, if the bundle is to be published from CI rather than
dragged into the console by hand.

1. Create the upload key once, on your own machine, and keep a copy. A key made
   in CI is a key nobody can back up — losing it is recoverable, since Play
   resets upload keys, but it costs a support round-trip. `keytool` comes with
   any JDK: `winget install Microsoft.OpenJDK.21` on Windows, or the JBR that
   Android Studio already ships.

   ```bash
   read -rsp 'Keystore password: ' STOREPASS; echo
   keytool -genkeypair -v -keystore warden-upload.keystore -alias warden \
     -keyalg RSA -keysize 4096 -validity 10000 \
     -storepass "$STOREPASS" -keypass "$STOREPASS"
   ```

   Read the password with `read -s` rather than `-storepass '<password>'`: a
   password on a command line is a password in the shell history.

   Then base64 the file, because a secret is text and a keystore is binary —
   and **no byte-order mark**: the workflow decodes it with `base64 -d`.

   ```bash
   # Git Bash, Linux
   base64 -w0 warden-upload.keystore > warden-upload.keystore.b64

   # macOS (no -w; the newlines have to go)
   base64 -i warden-upload.keystore | tr -d '\n' > warden-upload.keystore.b64

   # PowerShell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\warden-upload.keystore")) |
     Set-Content -NoNewline -Encoding ascii warden-upload.keystore.b64
   ```

   Add the four secrets. The two passwords are read from a hidden prompt so
   they are not in the history either; `gh` is not required — Settings →
   Secrets and variables → Actions does the same thing through the browser.

   ```bash
   gh secret set ANDROID_KEYSTORE_BASE64 < warden-upload.keystore.b64
   gh secret set ANDROID_KEYSTORE_PASSWORD   # prompts, input hidden
   gh secret set ANDROID_KEY_ALIAS --body warden
   gh secret set ANDROID_KEY_PASSWORD        # prompts, input hidden
   ```

   Commit neither file; `.gitignore` covers `*.keystore` and `*.keystore.b64`.
   CI writes `android/keystore.properties` from the secrets; without it the
   build is unsigned, and Play refuses an unsigned bundle by design.

2. The bundle is stamped the same way the iOS one is: the version name from the
   tag (a manual run takes `mobile/package.json`) and the **version code from
   the run number**, because Play rejects a code it has already seen and cannot
   be asked which ones are free. Never hand-bump `versionCode`.

3. Run **Mobile (Android)**, or push a `v*` tag. Every run first waits for the
   CI checks on the commit it is building (`.github/actions/wait-for-ci`): a tag
   on a commit that failed, or never got a run, stops before Gradle starts.

   A manual run **publishes** unless `dry_run` is ticked. Tick it while setting
   the secrets up: the bundle is built and signed, nothing reaches the track,
   and the log says which of the two it produced. Without the keystore the run
   still builds an unsigned bundle so a fork can be inspected; with it, the
   artifact is `WARDEN-<version>.aab`.

   To check the secrets arrived: after a `dry_run`, **Decode keystore** should
   show as executed rather than skipped, and the log must not contain *No
   keystore configured*. If it does, `ANDROID_KEYSTORE_BASE64` did not decode —
   usually a byte-order mark or a truncated copy.

   The Gradle distribution, the resolved dependencies and the local build cache
   are cached between runs, under a key that only changes when the wrapper or a
   build script does. A runner starts with an empty `~/.gradle`, so without that
   cache every release re-downloaded `gradle-8.13-all.zip` and the whole
   dependency set before compiling anything.

4. **The app must already exist in Play Console, with one release uploaded by
   hand.** The API uploads a bundle to an existing package and cannot create
   the app record, so an automated first upload fails with `Package not found`.
   The signed bundle for that first upload is the artifact from the `dry_run`
   above: download `WARDEN-<version>.aab`, then Play Console → Create app →
   Internal testing → Create new release → upload it yourself. That upload is
   also what enrols Play App Signing, which is why it cannot be automated away.

5. To let CI publish from then on, create a service account and give it exactly
   the permission it needs:

   - Google Cloud console → **enable the Google Play Android Developer API**.
   - Create a service account, then a **JSON key**; save the file.
   - Play Console → **Users and permissions** → invite the service account's
     email → app access to WARDEN → **Release apps to testing tracks**. That is
     enough for internal testing; do not grant production release.
   - `gh secret set PLAY_SERVICE_ACCOUNT_JSON < service-account.json`, or paste
     the file's contents into a repository secret.

   With that secret present every run uploads `WARDEN-<version>.aab` to the
   **internal** track marked completed, so the build is installable within
   minutes of the run finishing. Internal testing needs no review.

**This repository is already part-way there**, so a fork needs all of the above
and this one does not. The upload keystore exists — alias `warden`, 4096-bit RSA,
SHA-256 `62:EB:DA:C2:BA:2E:B9:3C:B7:51:D2:82:A9:CD:D3:BD:13:77:B7:C2:B1:E1:91:FE:FB:73:8E:C7:A7:D5:A4:8A`
— and all five secrets are set, so a `dry_run` now decodes it and signs the
bundle (`jarsigner -verify` says `jar verified`, certificate `CN=WARDEN`). The
Play publisher account `warden-play-publisher@warden-innotel.iam.gserviceaccount.com`
exists in the `warden-innotel` project with the Android Developer API enabled.
The key and its password live in `~/.warden-secrets` on the owner's machine, never
in the repository; **back them up**, because losing the upload key costs a Play
support round-trip to reset it.

What is left is Play Console itself, where no API can reach: the app record, its
first upload by hand (step 4), and inviting that service account with *Release
apps to testing tracks* (step 5). Until both are done the upload step stops with
`404 Package not found: us.innotel.warden` — that is Play saying the calling
account cannot see the app, not a signing or credentials fault.

**Publishing to Play is therefore switched by the `PLAY_PUBLISH` repository
variable, and it is off here.** Until Play Console is ready, a tag is Firebase
App Distribution plus the release page, and it stays green. Set the variable to
`true` once steps 4 and 5 are done and the same tag publishes to the internal
track as well. The upload is the *last* step in the job on purpose: a Play
rejection cannot take back an APK that is already on the release page.

### The upload key, and the two ways a release goes wrong

A bundle signed with a key Play does not know is rejected at upload. An APK that
is actually debug-signed is worse, because nothing else can tell: same name, same
build, same artifact, and Android then refuses every release-signed update until
each install is removed by hand. So `scripts/verify-apk-signature.py` reads the
signer certificate out of the APK and compares it with the upload key's
fingerprint before Firebase or the release page is touched — naming the debug
certificate when that is what it finds. The fingerprint is pinned in the script
rather than read from the keystore, because a check that trusts the same file the
build trusted proves nothing.

That makes the key worth keeping. `scripts/backup-upload-key.mjs` puts the
keystore and its password in one directory, writes `RESTORE.md` beside them, then
re-reads the copy to prove the fingerprint still matches:

```bash
node scripts/backup-upload-key.mjs \
  --keystore ~/.warden-secrets/warden-upload.keystore \
  --password-file ~/.warden-secrets/warden-upload-password.txt \
  --dest ~/Documents/warden-upload-key
```

It refuses a keystore that is not the pinned key, and refuses one it cannot open.
Move the result somewhere that outlives the machine — a password manager entry, a
synced folder, an encrypted disk. **The repository secrets are not a backup:**
GitHub never hands a secret value back, so they cannot restore a lost file.

6. Install it: Play Console → Internal testing → Testers → add your Google
   account, open the opt-in link on the phone, then install WARDEN from Play.
   Internal testers install through Play, not from a side-loaded file.

### Testing without Play (free)

Play costs $25 once and takes identity verification, and neither is needed to put
a build on a phone. Every run also builds an **APK**, which is what a device
actually installs:

- **From a run**: open the run → *warden-android-apk*. A `dry_run` gets you one
  without touching a track, which is the fastest loop while the app is being
  built out.
- **From a release**: a `v*` tag attaches it to the release page as
  `WARDEN-android.apk` — a name that never changes, so
  `https://github.com/innotelinc/warden/releases/latest/download/WARDEN-android.apk`
  is a single link to bookmark on the test phone and re-open after every tag.

On the phone: open the link, allow installs from the browser once, install.

With the keystore secret the APK is release-signed with the upload key — the
same identity a Play release would use, so nothing has to be uninstalled when
Play is configured later. **Without it the APK is debug-signed**: it installs,
but Android refuses to replace a debug-signed app with a release-signed one, so
uninstall first when you switch.

**Every run installs the APK before it publishes it.** A signature says the bytes
are signed; it says nothing about whether a phone will take them. So the `install`
job boots an Android emulator with nothing on it, installs the APK the run built,
resolves the launcher activity, launches it, and fails if the app is not in the
foreground eight seconds later, if it died, or if the version the device reports
is not the version that was built. That is the check that would have caught
0.2.11's debug-signed APK before a tester did.

This is a download, not a distribution service: no invitations, no update
prompt, no review. Firebase App Distribution adds those, and is wired up below.

### Firebase App Distribution (optional, free)

TestFlight-shaped, and no cost: testers are emailed an invite, install the build,
and are told when a new one arrives. Both mobile workflows distribute to it, and
both stay inert until it is configured — a fork, a dry run and today's setup
behave exactly as they did.

1. **Create the Firebase project and register both apps** (Project settings →
   General → Add app). The Android package must be exactly `us.innotel.warden`,
   and the iOS bundle id `us.innotel.warden`; Firebase refuses to change a
   package name after registration. Each app gets an **App ID** shaped
   `1:1234567890:android:0a1b…`.
2. **Create a tester group** (App Distribution → Testers & Groups) with the alias
   `testers`, or set `FIREBASE_TESTER_GROUPS` to whatever alias you use.
3. **Service account**: Google Cloud console → IAM & Admin → Service accounts →
   create one → Keys → **JSON**. Give it **Firebase App Distribution Admin** on
   the project, then add the file as the `FIREBASE_SERVICE_ACCOUNT` secret.
4. **Repository variables** (Settings → Secrets and variables → Actions →
   Variables): `FIREBASE_ANDROID_APP_ID`, `FIREBASE_IOS_APP_ID`, and optionally
   `FIREBASE_TESTER_GROUPS`.
5. Run **Mobile (Android)** without ticking `dry_run`, or push a `v*` tag: the
   signed APK is distributed to the group. A dry run builds and stops, because
   `dry_run` means "do not publish". iOS works the same way through
   `upload_to_testflight`: a tag publishes, and a manual run publishes only when
   that box is ticked, so the two boxes mean the same thing on both platforms.

**This repository is already registered**, so the steps above are only needed
for a fork: project `warden-innotel`, Android app
`1:1031472066945:android:bf654de1a4ce1cc07f3880`, iOS app
`1:1031472066945:ios:69db47ec449d951a7f3880`, tester group `testers`. The
`FIREBASE_SERVICE_ACCOUNT` secret and all three variables are set on the
repository, so a tag publishes to both platforms with no further setup.

The CLI is installed once into a cached prefix, under the version in
`FIREBASE_TOOLS_VERSION`, and the workflow calls that binary — not `npx`, which
fetched a 244 MB tree on every run and re-asked the registry each time even when
the tree was cached. The 0.2.12 iOS release spent 24 minutes on it. A hit costs
seconds and needs no network.

**iOS needs a second export, and it is Apple's rule rather than Firebase's.** An
App Distribution install must be an **ad hoc** build whose provisioning profile
names the installing device's UDID — an App Store-signed ipa cannot be side-loaded
at all. So the iOS job exports a second, ad hoc ipa (the TestFlight export is a
store build, and on a tag it writes no file at all), and that export can only
succeed once a device is on the developer account. **iOS device registration**
does that, with the same App Store Connect key and nothing installed:

```bash
gh workflow run ios-register-device.yml \
  -f udid=00008150-00084d5e0190c01c -f name='My iPhone'
```

It runs on Ubuntu in seconds and is idempotent — a UDID that is already on the
account is reported, not added twice. Registering is one-off, so it stays out of
the build: the next `mobile-ios.yml` run signs an ad hoc ipa that phone can
install. Check the artifact's `Payload/App.app/embedded.mobileprovision`: its
`ProvisionedDevices` should list the phone, the profile name should say *Ad Hoc*,
and `get-task-allow` should be `false`. Apple allows 100 devices per product
family per membership year.

**targetSdk is 36, and that is not cosmetic.** Play requires 36 for new apps and
updates submitted from 31 August 2026, and the extension to 1 November 2026 is
running out; an upload built against 35 is refused at the console. API 36 needs
an Android Gradle plugin whose ceiling includes it — 8.9 or later, with the
Gradle its compatibility table names — so both moved: AGP 8.13.2 on Gradle 8.13.
`tests/mobile-android.test.ts` fails if the SDK level or that pairing slips.

Two more Play checks that need no work here: the app ships no native `.so`
libraries, so the 16 KB page-size requirement is met by construction, and the
Data safety form answers the same as the iOS privacy form — nothing collected —
with `web/landing/privacy.html` as the policy URL.

### iOS

1. Create the app record in App Store Connect with bundle id
   `us.innotel.warden`. Automatic signing can register the bundle id and fetch a
   profile, but it cannot create this record, and an upload with nowhere to land
   fails.
2. Create an App Store Connect API key (Users and Access → Integrations →
   Team Keys) with the **Admin** role, and add repository secrets: `APPLE_TEAM_ID`,
   `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`,
   `APP_STORE_CONNECT_KEY_P8`.
3. Push a `v*` tag (or run **Mobile (iOS)** by hand). The workflow stamps the
   version from the tag — the manual run uses `mobile/package.json` — and the
   build number from the run number, which only ever increases, so every upload
   of 0.2.4 is accepted.
4. A tag push archives with automatic signing, exports with
   `destination=upload` and lands in **TestFlight**; no `altool` or Transporter
   step exists any more. A manual run **stops at the archive** unless it is
   asked for something: `upload_to_testflight` publishes, `export_signed_ipa`
   exports an ad hoc `.ipa` that installs on a registered phone and notifies
   nobody, and ticking neither leaves the `.xcarchive` and nothing else. Those
   two boxes are the whole decision — the store export, the ad hoc export, the
   profile check and the App Distribution publish all follow them, so a manual
   run can no longer mail a build to testers by accident.
5. Put the build in front of a phone. A `VALID` build reaches nobody until a
   **TestFlight group** holds it and an **internal tester** sits in that group,
   so: Apps → WARDEN → TestFlight → Internal Testing → a group (create one with
   `+` if the sidebar is empty), then **Add Builds** to choose the build and
   **Invite Testers** to add App Store Connect users by role. Tick *Enable
   automatic distribution* on the group and later uploads join it on their own,
   which is what the `Dev` group does. Internal testing needs no Beta App Review;
   external testing and the App Store do.
6. On the phone, install **TestFlight** from the App Store, sign in with the
   Apple ID that is a tester on the group, open WARDEN and tap **Install**. The
   build is listed as `0.2.4 (10)` — the number in brackets is the build number.
   Nothing appears under another Apple ID, and the iPhone must run at least the
   deployment target of 15.0.
7. When the binary is final, attach the build to the App Store version, fill in
   the listing (see *Submitting to the App Store*), and submit for review.

"Upload succeeded" only means App Store Connect took the file. It processes a
build for 5–15 minutes afterwards and can still reject it, so **iOS build
status** asks Apple what actually became of it:

```
gh workflow run ios-build-status.yml                      # report once
gh workflow run ios-build-status.yml -f wait_minutes=20   # poll until settled
gh workflow run ios-build-status.yml -f build_version=0.2.4
gh workflow run ios-build-status.yml -f build_number=10   # follow one build
gh workflow run ios-build-status.yml -f build_number=10 -f groups=true
gh workflow run ios-build-status.yml -f build_number=10 -f add_build_to_group=Dev
```

`groups=true` also reports every TestFlight group: whether it is internal or
external, whether it takes builds automatically, the build numbers it holds and
the testers in it — the difference between "Apple accepted the build" and
"somebody can install it". `add_build_to_group` does the *Add Builds* step from
the command line, and refuses unless the build is `VALID`.

The release job does not stop at the upload any more: after the export it runs
the same script with `--await-testers` and polls App Store Connect until the
build leaves processing **and** a TestFlight group that has testers in it holds
it. Processing takes 5–15 minutes; the step waits up to 45 and then fails the
tag, naming what was missing — no group holds the build, or the group that does
has nobody in it. A green release no tester can install is worse than a red one,
so this is a failure rather than a warning.

`submission=true` answers the other question — what App Store Connect still
wants before the version can be sent to review:

```
gh workflow run ios-build-status.yml -f submission=true
```

**iOS listing** writes that copy into App Store Connect so the record cannot
drift from the reviewed file — `dry_run` defaults to true:

```
gh workflow run ios-listing.yml                      # show what it would change
gh workflow run ios-listing.yml -f dry_run=false
gh workflow run ios-listing.yml -f dry_run=false -f attach_build=10
```

It sets the version's description, keywords, promotional text and URLs, the
subtitle and privacy policy URL, the primary category, the whole age rating
questionnaire (unrestricted web access answered yes, which produces 16+) and,
with `attach_build`, the build on the version page. It leaves the app name,
the screenshots and the review contact alone: those are a person's details or
have to come from the running app.

It reports every field of the newest iOS version page (description, keywords,
URLs, promotional text, what's new), the screenshots per display size, the app
information (name, subtitle, privacy policy URL, primary category), the age
rating, and whether a build and review details are attached. Each line is `ok`
or `GAP`, and the job exits non-zero while anything is missing, so a checklist
cannot drift from the record. The version page and the build carry independent
numbers: a version page of `1.0` accepts a build stamped `0.2.4`, but keeping
them equal avoids explaining the difference later.

It prints the marketing version, build number, upload time in UTC and the
processing state (`PROCESSING`, `VALID`, `FAILED`, `INVALID`) with what each one
means, runs on Ubuntu in seconds, and exits non-zero when a build is still
processing when the wait runs out or has failed. `scripts/ios-build-status.py`
signs its own App Store Connect token with `openssl`, so nothing is installed on
the runner.

Without the four secrets the job still archives (unsigned) so a fresh clone has
something to inspect; it prints a notice instead of failing.

The key's role matters more than it looks. Cloud signing creates the development
certificate for the archive under any role that can reach the Developer Portal,
but it will only manage *distribution* signing — the certificate and App Store
profile the export needs — for an **Admin** (or Account Holder) key. An App
Manager key archives fine and then fails the export with
`Cloud signing permission error`, `No profiles for 'us.innotel.warden' were
found` and `No signing certificate "iOS Distribution" found`, which reads like a
missing app record and is not one. A Team Key's role cannot be edited after it
is generated: revoke it and make a new key, then update
`APP_STORE_CONNECT_KEY_ID` and `APP_STORE_CONNECT_KEY_P8`. The issuer id and team
id do not change.

The SDK is the other half of the upload. App Store Connect accepts nothing built
with an SDK older than **iOS 26** (Xcode 26 or later), and the `macos-15` runner
image still defaults to Xcode 16.4, so the workflow selects the newest stable
Xcode on the image and refuses to continue if `xcrun --sdk iphoneos
--show-sdk-version` reports anything below 26. That check exists because the
first successful upload was rejected *after* analysis with `SDK version issue`,
which costs a full build to discover. Xcode 26 supports iOS 15 and later, so the
deployment target is 15.0 in both `App.xcodeproj` and `Podfile`.

The App Privacy form is *Data Not Collected*, which `App/PrivacyInfo.xcprivacy`
states in the app bundle as well. Export compliance is answered by
`ITSAppUsesNonExemptEncryption = false` in `Info.plist`, so no exemption
paperwork is needed.

What is already in the repository, so nobody regenerates it by hand:

- `App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png` — the WARDEN mark
  flattened onto its own background and cropped past the macOS-style rounding,
  because iOS applies the mask itself. 1024×1024, no alpha channel.
- `App/Assets.xcassets/Splash.imageset/` — the same art on a 2732×2732 launch
  background, and `LaunchScreen.storyboard` paints that background rather than
  the system colour, so there is no white flash on launch.
- `App/PrivacyInfo.xcprivacy` — no tracking, no collected data, and the two
  required-reason APIs Capacitor's bridge touches (UserDefaults, file
  timestamps).
- `App/Info.plist` — `WKAppBoundDomains` listing `localhost`, which is what
  `ios.limitsNavigationsToAppBoundDomains` needs so the bridge WebView can never
  be navigated off the shell's own origin.
- `App.xcodeproj/xcshareddata/xcschemes/App.xcscheme` — a shared scheme, without
  which `xcodebuild -scheme App` has nothing to build on a fresh checkout.

## Submitting to the App Store

Everything below is copied from `mobile/store/ios/listing.json`, which is the
source of truth; the limits are Apple's and a test enforces them.

**App Information**

| Field | Value | Limit |
|---|---|---|
| Name | `WARDEN — private browser` | 30 |
| Subtitle | `No account. No telemetry.` | 30 |
| Primary language | English (U.S.) | — |
| Bundle ID | `us.innotel.warden` | — |
| SKU | `WARDEN-MOBILE` | — |
| Primary category | Utilities | — |
| Content rights | Does not contain third-party content | — |
| Age rating | see below — **16+** | — |

**Age rating: 16+, and this is not a marketing choice.** The app has an address
field, so it offers unrestricted web access. Answer that question **Yes**; Apple
defines that capability as 16+ under the current 4+/9+/13+/16+/18+ scheme (17+
on older OS versions), and every comparable browser is rated the same — Chrome,
Firefox and DuckDuckGo are all 16+ in the US store. Answer everything else
None, and *Made for Kids* No. New submissions also require the social-media
questions added in September 2026; a browser displaying websites is not a
social feature, so answer No to those.

**App Privacy** — *Data Not Collected*. That is real: the app stores no history,
profile or identifiers of its own, ships no analytics or ad SDK, and the browser
surface keeps its session in a non-persistent store that is discarded when it
closes, so nothing survives to be collected. Browsing history does
**not** have to be declared merely because users browse the open web; declare it
only if the app or an SDK actually logs or uploads visited URLs. It does not.
`App/PrivacyInfo.xcprivacy` states the same inside the bundle, and Capacitor
ships its own manifest, so the listed-SDK expectation is met.

**Version page**

| Field | Value | Limit |
|---|---|---|
| Promotional text | from `listing.json` | 170 |
| Description | from `listing.json` | 4,000 |
| Keywords | `privacy,browser,security,network admin,private browsing,no tracking,sysadmin,web` | 100 **bytes** |
| Support URL | `https://github.com/innotelinc/warden/issues` | required |
| Marketing URL | `https://innotelinc.github.io/warden/` | optional |
| Privacy Policy URL | `https://innotelinc.github.io/warden/privacy.html` | required |
| Copyright | `2026 Innotel` | required |
| What's New | blank for 0.2.4 — it is the first version | 4,000 |
| Build | select `0.2.4 (9)` once it is `VALID` | — |
| Sign-in required | **No** — no demo account to supply | — |
| Review notes | from `listing.json` | 4,000 |

**Screenshots — both sizes, and they must be real.** `TARGETED_DEVICE_FAMILY`
is `"1,2"`, so App Store Connect demands 6.9" iPhone (1290×2796) **and** 13"
iPad (2048×2732) shots. They have to come from the running build on a device or
simulator; nothing in this repository can generate them, and a mockup of a UI
that does not exist is a 2.3 rejection.

**Review notes have one job: explain what the app is before a reviewer decides
it is a wrapper.** They are in the listing file and say, in order: no sign-in
needed; how to test (type `example.com`, press return, the page opens in WARDEN's
own view with the app's address bar and controls, dismiss it, no permission
prompt appears); why it is not a repackaged website (no bundled site, no server,
no account, its own address resolution, posture screen, blocking and quick
destinations); what the operator surfaces are (Scry's report, the service and
mail clients in their own session); and what is deliberately absent.

**Be honest about 4.2.** A browser is exactly the shape of app that guideline
4.2 (minimum functionality) questions. Rendering in a `WKWebView` is the right
answer for a browser, but the guideline is about what the app *does*, so the
review notes have to name the blocking, the session posture and the chrome as
the app's own work — now three surfaces of it
(the browser, Scry's report builder, and the service session) rather than one.
Review notes explain the product; they cannot supply functionality that is not
there, so the notes also say what is absent. Remaining roadmap: per-tab
isolation and DoH via `NEDNSProxyProvider`. Treat rejection on 4.2 as a live
possibility rather than a surprise, and answer it with the surfaces, not with
copy.

**The claim the app must never make, because it is not true in this build:**
that it encrypts DNS, or that tabs are isolated. There is no DNS profile in the
app and no per-tab store. Blocking ships now, so it is no longer on that list —
`tests/mobile-listing.test.ts` fails if a DNS claim comes back.

**Export compliance** is answered in `Info.plist`
(`ITSAppUsesNonExemptEncryption = false`), so selecting a build does not stop for
the encryption questionnaire.

## Store metadata

`mobile/store/android/listing.json` and `mobile/store/ios/listing.json` hold the
text that goes into both consoles: titles, descriptions, category, contact and
privacy URLs, data-safety answers, rating expectations and review notes. Copy
them in verbatim so the two listings and this repository agree.

App icons are in the repository for iOS (above); Android's launcher icons are
still Capacitor's generated set. Screenshots are the remaining graphics:
they have to come from the running app, so they are captured once the first
internal build exists and show the real UI rather than a mockup.

## What the owner still has to do

- Google Play: account existence, identity verification and the one-time $25
  fee. The Play Console app record cannot be created by automation without that
  account, and the first `.aab` upload has to come from a signed build. Testing
  does not need any of it — the APK route above installs on a phone today.
- Apple: the developer account exists. Three things are still only doable from
  the account: create the app record in App Store Connect for
  `us.innotel.warden`, create the App Store Connect API key, and set the four
  secrets above. Everything after that runs from a tag.
- Both stores: confirm the developer name, support email and privacy-policy URL
  (`https://innotelinc.github.io/warden/privacy.html`, deployed by the Pages
  workflow from `web/landing/`).
- App Review, worth answering before it is asked: 4.2 (minimum functionality)
  is the guideline a browser shell gets questioned under. The listing's review
  notes should say plainly what the app is for and why it is not a shortcut to a
  website — the session posture and quick destinations are the app's own, and it
  collects nothing.

## Non-goals

The mobile app is not a port of the desktop process model. It runs the same
*browser* with the same blocking lists, the same Scry report builder and the same
service list, and it does not claim the parts of the desktop that need something
a store app cannot have:

- **The shell.** A local PTY needs a child process; the desktop's SSH route is the
  system `ssh` client. Neither exists inside an app sandbox.
- **The IMAP/SMTP client.** Porting it means a native IMAP stack on two platforms
  plus a keychain for the credentials; until that exists, Mail is the provider's
  web client in a service session, and the panel says so.
- **Genie.** It posts to an OpenAI-compatible gateway with the owner's key. The
  mobile build has no key store for it, and putting an API key in plain
  preferences on a phone is not a trade this product should make.

The store listing says browser and blocking, which is what ships.

## Operator surfaces on a phone

Scry, Services and Mail are peers of the browser, not settings behind it: the tab
bar sits under the address bar, because an operator switching from reading a page
to reading its stack should not have to go hunting.

### Scry

A phone has no Chrome debugger, so the capture runs **inside the page**:
`mobile/src/operator/capture.ts` is a self-contained function that the native
surface evaluates once the document settles, and `Function.prototype.toString`
is what gets sent, so the script and its test are the same code. It collects the
DOM, `document.cookie`, the Resource Timing entries (which give hosts, request
kinds, sizes and XHR/fetch endpoints), the forms, and a sample of the design
tokens.

The report is then built by **`src/shared/scry-report.ts`**, the same builder the
desktop runs over a debugger capture. That is the point of the move: a tracker
host or a framework signature that lived twice would be right on one platform and
quietly wrong on the other.

Two honest differences from the desktop report, both stated in its notes:

- **Response headers cannot be read from inside a page**, and the mobile engine
does not hand them to the shell. `headersObserved: false` stops the report calling
every security header missing; server software (nginx, Cloudflare) is therefore
absent from a mobile report, and Scry on the desktop is where to read it.
- **A blocked request never reaches the page**, so it cannot appear in the
capture. The third-party and tracker lists are a lower bound — what got through —
not a measurement of the site. The same caveat the desktop prints when it knows
how many requests Bastion refused.

### Services and Mail

Both open the service's own web client in WARDEN's surface. What makes them
usable is the session: a chat app that asked for a login on every open would not
be.

| | Browser | Service |
|---|---|---|
| iOS store | `.nonPersistent()` | `.default()` |
| Android store | the main process's WebView directory | `app_webview_services`, in `:services` |
| On close | cookies, web storage, form data and cache cleared | kept |
| How it ends | closing the surface | **Sign out of every service** |

Android needs the second **process**, not just a flag: `CookieManager` and
`WebStorage` are per process, so a private page's teardown would otherwise sign
the operator out of every chat app they had open. `WardenServicesActivity` runs
with `android:process=":services"` and calls `WebView.setDataDirectorySuffix`
before its first `WebView` exists. On API 27 and older there is no suffix, so the
two sessions share one store and clearing the browser clears the services with
it. iOS needs nothing extra: two data stores are two stores.

Mail is the provider's web client, not the desktop program. The desktop talks
IMAP and SMTP, analyses a message for fraud and renders sanitised HTML; none of
those has a mobile path yet, and the panel says so rather than implying an IMAP
client that is not there.

## The iOS browser surface

The shell used to hand every address to `SFSafariViewController`, which is
another app's UI: pages opened, but WARDEN had no address bar of its own and no
idea where the operator had gone. iOS now renders pages in a `WKWebView` the app
presents itself, with an editable address, back, forward, reload and a way out —
`mobile/plugins/warden-browser`, a local Capacitor plugin.

Three things about it are deliberate:

- **The session is memory only.** `websiteDataStore = .nonPersistent()`, which is
  what the shell's posture screen claims and what the desktop product does.
  Cookies and cache go when the surface does.
- **Unknown schemes leave the app.** `mailto:`, `tel:` and app deep links are
  handed to the system rather than swallowed by a view that cannot honour them.
- **The platform piece is optional at runtime.** `mobile/src/warden-browser.ts`
  falls back to the system browser if the plugin is not registered, so an older
  build or Android still opens the page and is told which surface it used.

The plugin is a `file:` dependency of `mobile/package.json`, so `npx cap sync ios`
writes the pod into `Podfile` and the class into `packageClassList` on its own —
do not hand-write either, or CocoaPods sees the pod twice. `npm ci` must therefore
run before `pod install`, which `mobile-ios.yml` already does.

Compiling Swift cannot be verified outside macOS; the wiring is pinned by
`tests/mobile-ios-browser.test.ts`.
