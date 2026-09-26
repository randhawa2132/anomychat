import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const { name } = JSON.parse(await readFile(resolve(root, "public/branding.json"), "utf8"));
if (typeof name !== "string" || !name.trim() || name.length > 40) throw new Error("Invalid app name in branding.json");
const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

const capacitorPath = resolve(root, "capacitor.config.ts");
const capacitor = await readFile(capacitorPath, "utf8");
await writeFile(capacitorPath, capacitor.replace(/appName: "[^"]*"/, `appName: ${JSON.stringify(name)}`));

const androidPath = resolve(root, "android/app/src/main/res/values/strings.xml");
let android = await readFile(androidPath, "utf8");
for (const key of ["app_name", "title_activity_main"]) {
  android = android.replace(new RegExp(`(<string name="${key}">)[^<]*(</string>)`), (_, start, end) => `${start}${xml(name)}${end}`);
}
await writeFile(androidPath, android);

const iosPath = resolve(root, "ios/App/App/Info.plist");
let ios = await readFile(iosPath, "utf8");
ios = ios.replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/, (_, start, end) => `${start}${xml(name)}${end}`);
ios = ios.replace(/(<key>NSCameraUsageDescription<\/key>\s*<string>)[^<]* uses the camera for video calls\.(<\/string>)/, (_, start, end) => `${start}${xml(name)} uses the camera for video calls.${end}`);
ios = ios.replace(/(<key>NSMicrophoneUsageDescription<\/key>\s*<string>)[^<]* uses the microphone for voice and video calls\.(<\/string>)/, (_, start, end) => `${start}${xml(name)} uses the microphone for voice and video calls.${end}`);
await writeFile(iosPath, ios);
