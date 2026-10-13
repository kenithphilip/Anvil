// The two screens that start a WebAuthn ceremony call @simplewebauthn/browser
// in the documented object form: startRegistration({ optionsJSON }) and
// startAuthentication({ optionsJSON }). The bare-options form still runs in
// v14 through a legacy shim that console.warns on every call, and the shim
// can go in any major. The ceremony result must reach the finish endpoint
// unchanged.
//
// Every value is invented.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const W = vi.hoisted(() => ({
  startRegistration: null as any,
  startAuthentication: null as any,
}));
vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: (...a: unknown[]) => W.startRegistration(...a),
  startAuthentication: (...a: unknown[]) => W.startAuthentication(...a),
}));

const REG_OPTIONS = { challenge: "reg-challenge", rp: { name: "Anvil", id: "anvil.example.com" }, user: { id: "dXNlcg", name: "u", displayName: "U" }, pubKeyCredParams: [{ alg: -7, type: "public-key" }] };
const AUTH_OPTIONS = { challenge: "auth-challenge", rpId: "anvil.example.com", allowCredentials: [] };
const ATTESTATION = { id: "cred-1", rawId: "cred-1", type: "public-key", response: { clientDataJSON: "c", attestationObject: "a" }, clientExtensionResults: {} };
const ASSERTION = { id: "cred-1", rawId: "cred-1", type: "public-key", response: { clientDataJSON: "c", authenticatorData: "d", signature: "s" }, clientExtensionResults: {} };

let savedHash = "";
beforeEach(() => {
  savedHash = window.location.hash;
  W.startRegistration = vi.fn(async () => ATTESTATION);
  W.startAuthentication = vi.fn(async () => ASSERTION);
  installRbac("admin");
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});
afterEach(() => {
  window.location.hash = savedHash;
  vi.unstubAllGlobals();
});

describe("passkey ceremonies call @simplewebauthn/browser with { optionsJSON }", () => {
  it("sign-in: startAuthentication({ optionsJSON }) and the assertion goes to auth/finish", async () => {
    const auth = {
      passkeyAuthBegin: vi.fn(async () => ({ options: AUTH_OPTIONS, challenge_id: "loginchallenge::abc" })),
      // No session: the screen stops at an error instead of redirecting.
      passkeyAuthFinish: vi.fn(async () => ({ user: { email: "operator@example.com" }, session: {} })),
    };
    installBackend({ auth, getConfig: () => ({ url: "https://anvil.example.com" }) });

    const Screen = (await import("./signin")).default;
    const { container, getByText } = renderScreen(Screen);
    const email = container.querySelector('input[type="email"]') as HTMLInputElement;
    fireEvent.change(email, { target: { value: "operator@example.com" } });
    fireEvent.click(getByText("Sign in with passkey"));

    await waitFor(() => expect(auth.passkeyAuthFinish).toHaveBeenCalled());
    expect(auth.passkeyAuthBegin).toHaveBeenCalledWith("operator@example.com");
    expect(W.startAuthentication).toHaveBeenCalledTimes(1);
    expect(W.startAuthentication).toHaveBeenCalledWith({ optionsJSON: AUTH_OPTIONS });
    expect(auth.passkeyAuthFinish).toHaveBeenCalledWith("operator@example.com", "loginchallenge::abc", ASSERTION);
  });

  it("admin security tab: startRegistration({ optionsJSON }) and the attestation goes to register/finish", async () => {
    window.location.hash = "#/admin?tab=security";
    const auth = {
      mfaSettings: vi.fn(async () => ({ totp_enrolled: false, passkey_enrolled: false })),
      passkeyList: vi.fn(async () => ({ passkeys: [] })),
      passkeyRegisterBegin: vi.fn(async () => ({ options: REG_OPTIONS, pending_id: "pending::u::1" })),
      passkeyRegisterFinish: vi.fn(async () => ({ ok: true, credential_id: "cred-1" })),
    };
    installBackend({ auth });

    const Screen = (await import("./admin")).default;
    const { findByText } = renderScreen(Screen);
    fireEvent.click(await findByText("Register passkey"));

    await waitFor(() => expect(auth.passkeyRegisterFinish).toHaveBeenCalled());
    expect(W.startRegistration).toHaveBeenCalledTimes(1);
    expect(W.startRegistration).toHaveBeenCalledWith({ optionsJSON: REG_OPTIONS });
    expect(auth.passkeyRegisterFinish).toHaveBeenCalledWith("pending::u::1", ATTESTATION);
  });
});
