# Generic Android app

The AnomyChat APK contains no Matrix accounts, server secrets, or fixed organization URL. At sign-in, enter your organization's HTTPS server URL, Matrix username, and password. The server must expose the Matrix client API at `/_matrix/`. Save your Matrix recovery key separately so a new device can restore encrypted history.

The APK is a Capacitor WebView wrapping this repository's web client. It supports foreground messaging and calls where browser APIs and permissions allow them. Android background alerts use Firebase Cloud Messaging after the app and server are configured with the same Firebase project. Alerts contain a generic notice, not message text or encryption keys. Tapping an alert opens the app to sync and decrypt. A closed-app incoming call receives a generic alert; it does not provide a native answer screen. The app requires Android 7.0+ and normal HTTPS certificate validation. It does not trust arbitrary self-signed server certificates in release builds.

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

## Enable Android background alerts

1. In your Firebase project, register an Android app whose package ID matches `android/app/build.gradle` (`org.anomychat.app` by default). Place the downloaded `google-services.json` in `android/app/` before `npm run mobile:sync` and rebuilding the APK. This file is ignored by Git.
2. In Firebase project settings, create a **service account private key** for Cloud Messaging. On the server, place it at `infra/server/data/push/fcm-service-account.json` with file permissions `600`, owned by the account running the push container. Never place this key in the APK, website, repository, or a support request.
3. Rebuild the server push container with `docker compose -f infra/server/compose.yaml up -d --build push`. Rebuild and install the APK. Sign in, open Settings, enable background alerts, and send a test alert. Allow Android notifications when prompted.

The mobile Firebase app and the server service account must belong to the same Firebase project. Other organizations can use the published APK for messaging, but to run independent native alerts they must build their own APK and configure their own Firebase project. Web Push remains available in supported browsers without Firebase.

The generic APK leaves the server URL blank on first sign-in. If you fork this project to hardcode a default, set `VITE_MATRIX_BASE_URL` only for your own build. A default URL is public configuration, not a secret. Changing server URL later signs into a different Matrix installation; encrypted history and user IDs do not migrate automatically.
