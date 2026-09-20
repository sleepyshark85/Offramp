# Getting Offramp onto a phone

There is no Mac in this project. Everything below runs from Linux.

## Why there is a build step at all

Offramp draws its play surface with `@shopify/react-native-skia`, which is a native module
and is **not** part of the Expo Go runtime. Expo Go therefore cannot run this app, and no
amount of JS-only work changes that. What replaces it is a **development build** — a small
custom app, built once, that contains Offramp's native modules and otherwise behaves exactly
like Expo Go: it connects to the Metro dev server on this machine and hot-reloads JavaScript.

The distinction that matters day to day: **the native build is only rebuilt when native
dependencies change.** Adding a screen, changing the engine, retuning the generator — all JS,
all instant. Adding a native module — rebuild, about fifteen minutes, in the cloud.

## iOS, with no Mac

EAS Build runs macOS workers in Expo's cloud. Xcode is never installed locally. This needs
the paid Apple Developer Program membership, which the owner has.

```bash
npm install -g eas-cli          # once
eas login                       # once
eas init                        # once — writes extra.eas.projectId into app.json

eas device:create               # once per test device: registers the iPhone's UDID,
                                # produces a QR/link to open on the phone
eas build --platform ios --profile development
```

`development` in `eas.json` sets `developmentClient: true` and `distribution: internal`, so
the result is a dev client installable straight from the build link rather than something
that has to go through TestFlight. EAS prompts for Apple credentials on the first build and
manages signing and provisioning after that.

Install from the link the build prints, then:

```bash
npm start                       # expo start --dev-client
```

Scan the QR from the dev client. From here iteration is JS-only.

**When the UDID list changes** — a new device, or a wiped one — the provisioning profile no
longer covers it and the app must be rebuilt after `eas device:create`.

## Android

Same flow, no developer account needed for a dev build:

```bash
eas build --platform android --profile development   # produces an installable .apk
```

Or build locally if the Android SDK is ever installed here, which would remove the cloud
round trip entirely for Android.

## The four things that break, in the order they usually break

1. **A native dependency was added and the build was not redone.** The symptom is a red
   screen naming a missing native module. JS reloading will never fix it.
2. **Metro is not reachable.** The phone and this machine must be on the same network. If
   they are not, `npx expo start --dev-client --tunnel`.
3. **The UDID is not on the profile.** iOS install fails before the app ever opens.
4. **Stale bundle after a dependency change.** `npx expo start --dev-client --clear`.

## What on-device testing is for

It is **tier 5** in `docs/development-process.md` §4, and it is the only tier that proves
iOS. Tiers 1–4 run on this machine and prove rules, generation fairness, the state-to-paint
path, and layout arithmetic. None of them prove touch latency, sustained frame rate with a
full network on screen, haptics, or how the game actually feels under time pressure — which
for a real-time attention game is most of what matters.

Report from tier 5 in specifics: *"cars stutter when more than nine are on screen"* is
actionable; *"feels laggy"* is not.
