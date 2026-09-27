/** Change a Matrix password using the server's user-interactive auth challenge. */
export async function changeMatrixPassword(baseUrl: string, accessToken: string, userId: string, currentPassword: string, newPassword: string): Promise<void> {
  const endpoint = new URL("/_matrix/client/v3/account/password", baseUrl);
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
  const body = { new_password: newPassword, logout_devices: true };
  let response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  if (response.status === 401) {
    const challenge = await response.json();
    if (!challenge.session || !challenge.flows?.some((flow: { stages: string[] }) => flow.stages?.includes("m.login.password"))) {
      throw new Error("This server requires another authentication method. Ask an administrator for help.");
    }
    response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({
      ...body, auth: { type: "m.login.password", identifier: { type: "m.id.user", user: userId }, password: currentPassword, session: challenge.session },
    }) });
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Server returned ${response.status}.`);
  }
}
