import { readFile } from "node:fs/promises";
import { JWT } from "google-auth-library";

export async function createFcm(path) {
  let serviceAccount;
  try { serviceAccount = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const { project_id: projectId, client_email: email, private_key: key } = serviceAccount;
  if (!/^[a-z][a-z0-9-]{3,63}$/.test(projectId) || typeof email !== "string" || typeof key !== "string") throw new Error("Invalid Firebase service account file");
  const auth = new JWT({ email, key, scopes: ["https://www.googleapis.com/auth/firebase.messaging"] });
  return async (registrationToken, test = false) => {
    const { token } = await auth.getAccessToken();
    if (!token) throw new Error("Firebase service account could not obtain an access token");
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: fcmPayload(registrationToken, test) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const error = new Error("FCM rejected Android notification");
      error.statusCode = response.status;
      if (response.status === 404) error.code = "messaging/registration-token-not-registered";
      throw error;
    }
  };
}

export function fcmPayload(registrationToken, test = false) {
  return {
    token: registrationToken,
    notification: { title: test ? "Test alert" : "New activity", body: test ? "Background alerts are ready on this device." : "Open the app to view your encrypted messages." },
    android: { priority: "high" },
  };
}
