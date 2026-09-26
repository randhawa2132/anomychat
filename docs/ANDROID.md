# Generic Android app

The AnomyChat APK contains no Matrix accounts, server secrets, or fixed organization URL. At sign-in, enter your organization's HTTPS server URL, Matrix username, and password. The server must expose the Matrix client API at `/_matrix/`. Save your Matrix recovery key separately so a new device can restore encrypted history.

The APK is a Capacitor WebView wrapping this repository's web client. It supports foreground messaging and calls where browser APIs and permissions allow them. **Native background push is not implemented**; the browser-installed PWA is the supported route for closed-app Web Push alerts. The app requires Android 7.0+ and normal HTTPS certificate validation. It does not trust arbitrary self-signed server certificates in release builds.

## Install a published release

Download the APK from this repository's GitHub **Releases** page, not from a copy in a chat message. Compare its SHA-256 with the release notes. Android may ask you to allow installation from the browser or file manager. Disable that permission again afterward. Updates must be signed with the same key and have a higher version code. The signing key is never stored in GitHub.

## Build from source

Install Node.js 22.12+, Android SDK 36, JDK 21, and Android platform/build tools. From the repository root:

```sh
npm ci
npm run mobile:sync
cd android
./gradlew assembleDebug
```

On Windows use `gradlew.bat`. The debug APK appears at `android/app/build/outputs/apk/debug/app-debug.apk` for local tests only. A distributable release requires a privately held signing keystore. Set `ANOMYCHAT_KEYSTORE`, `ANOMYCHAT_KEYSTORE_PASSWORD`, `ANOMYCHAT_KEY_ALIAS`, and `ANOMYCHAT_KEY_PASSWORD` in your build environment, then run `./gradlew assembleRelease`. Verify the APK signature with Android `apksigner verify --verbose` and keep the keystore plus passwords in separate secure backups. Losing the key prevents updates to existing installations. Do not commit keystores, passwords, or `google-services.json`.

The generic APK leaves the server URL blank on first sign-in. If you fork this project to hardcode a default, set `VITE_MATRIX_BASE_URL` only for your own build. A default URL is public configuration, not a secret. Changing server URL later signs into a different Matrix installation; encrypted history and user IDs do not migrate automatically.
