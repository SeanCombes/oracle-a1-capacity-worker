import { describe, expect, it } from "vitest";
import {
  privateKeyPemToDer,
  sha256Base64,
  signOciRequest,
  type OciSigningCredentials,
} from "../src/oci-signing";

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function testKeys(): Promise<{
  credentials: OciSigningCredentials;
  publicKey: CryptoKey;
}> {
  const generated = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  if (generated instanceof CryptoKey) throw new Error("Expected an RSA key pair");
  const exported = await crypto.subtle.exportKey("pkcs8", generated.privateKey);
  if (!(exported instanceof ArrayBuffer)) {
    throw new Error("Expected a PKCS#8 ArrayBuffer");
  }
  const privateDer = new Uint8Array(exported);
  const credentials = {
    tenancyId: "ocid1.tenancy.oc1..test",
    userId: "ocid1.user.oc1..test",
    fingerprint: "00:11:22:33",
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${toBase64(privateDer)}\n-----END PRIVATE KEY-----\nOCI_API_KEY`,
  };
  return { credentials, publicKey: generated.publicKey };
}

function signatureFromAuthorization(value: string): string {
  const match = /signature="([^"]+)"/.exec(value);
  if (!match?.[1]) throw new Error("Missing signature");
  return match[1];
}

describe("OCI request signing", () => {
  it("matches the SHA-256 reference vector", async () => {
    expect(await sha256Base64("abc")).toBe(
      "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
    );
  });

  it("creates a verifiable GET signature over path and ordered query", async () => {
    const { credentials, publicKey } = await testKeys();
    const date = new Date("2014-01-05T21:31:40.000Z");
    const url = new URL(
      "https://resourcemanager.eu-stockholm-1.oraclecloud.com/20180917/jobs?stackId=ocid1.test&sortBy=TIMECREATED",
    );

    const headers = await signOciRequest({ method: "GET", url, date }, credentials);
    const signingString = [
      `(request-target): get ${url.pathname}${url.search}`,
      `host: ${url.host}`,
      `date: ${date.toUTCString()}`,
    ].join("\n");
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      fromBase64(signatureFromAuthorization(headers.get("authorization") ?? "")),
      encoder.encode(signingString),
    );

    expect(valid).toBe(true);
    expect(headers.get("authorization")).toContain(
      'headers="(request-target) host date"',
    );
  });

  it("signs all OCI-required POST body headers and byte length", async () => {
    const { credentials, publicKey } = await testKeys();
    const date = new Date("2014-01-05T21:31:40.000Z");
    const url = new URL(
      "https://resourcemanager.eu-stockholm-1.oraclecloud.com/20180917/jobs",
    );
    const body = '{"label":"räksmörgås"}';

    const headers = await signOciRequest(
      { method: "POST", url, date, body },
      credentials,
    );
    const signingString = [
      `(request-target): post ${url.pathname}`,
      `host: ${url.host}`,
      `date: ${date.toUTCString()}`,
      `x-content-sha256: ${headers.get("x-content-sha256")}`,
      "content-type: application/json",
      `content-length: ${encoder.encode(body).byteLength}`,
    ].join("\n");
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      fromBase64(signatureFromAuthorization(headers.get("authorization") ?? "")),
      encoder.encode(signingString),
    );

    expect(valid).toBe(true);
    expect(headers.get("content-length")).toBe(
      encoder.encode(body).byteLength.toString(),
    );
    expect(headers.get("authorization")).toContain(
      'headers="(request-target) host date x-content-sha256 content-type content-length"',
    );
  });

  it("accepts Oracle's OCI_API_KEY marker and rejects unsupported key formats", async () => {
    const { credentials } = await testKeys();
    expect(privateKeyPemToDer(credentials.privateKeyPem).byteLength).toBeGreaterThan(0);
    expect(() =>
      privateKeyPemToDer(
        "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
      ),
    ).toThrow(/PKCS#8/);
  });
});
