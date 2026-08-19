const encoder = new TextEncoder();

export interface OciSigningCredentials {
  tenancyId: string;
  userId: string;
  fingerprint: string;
  privateKeyPem: string;
}

export interface SignRequestInput {
  method: "GET" | "POST";
  url: URL;
  body?: string;
  date?: Date;
  extraHeaders?: Record<string, string>;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function privateKeyPemToDer(pem: string): Uint8Array<ArrayBuffer> {
  if (!pem.includes("-----BEGIN PRIVATE KEY-----")) {
    throw new Error(
      "OCI_PRIVATE_KEY must be an unencrypted PKCS#8 PEM beginning with BEGIN PRIVATE KEY",
    );
  }

  const base64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\bOCI_API_KEY\b/g, "")
    .replace(/\s/g, "");

  if (!base64) throw new Error("OCI_PRIVATE_KEY contains no key data");
  return base64ToBytes(base64);
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    privateKeyPemToDer(pem),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
}

export async function sha256Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64(new Uint8Array(digest));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function signOciRequest(
  input: SignRequestInput,
  credentials: OciSigningCredentials,
): Promise<Headers> {
  const method = input.method.toLowerCase();
  const requestTarget = `${input.url.pathname}${input.url.search}`;
  const date = (input.date ?? new Date()).toUTCString();
  const body = input.body ?? "";
  const signedNames = ["(request-target)", "host", "date"];
  const signingLines = [
    `(request-target): ${method} ${requestTarget}`,
    `host: ${input.url.host}`,
    `date: ${date}`,
  ];

  const headers = new Headers({
    date,
    ...(input.extraHeaders ?? {}),
  });

  if (input.method === "POST") {
    const contentType = "application/json";
    const contentLength = encoder.encode(body).byteLength.toString();
    const contentHash = await sha256Base64(body);

    signedNames.push("x-content-sha256", "content-type", "content-length");
    signingLines.push(
      `x-content-sha256: ${contentHash}`,
      `content-type: ${contentType}`,
      `content-length: ${contentLength}`,
    );
    headers.set("x-content-sha256", contentHash);
    headers.set("content-type", contentType);
    // Workers derives the actual Content-Length from the fixed string body.
    headers.set("content-length", contentLength);
  }

  const key = await importPrivateKey(credentials.privateKeyPem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(signingLines.join("\n")),
  );
  const keyId = `${credentials.tenancyId}/${credentials.userId}/${credentials.fingerprint}`;

  headers.set(
    "authorization",
    `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${signedNames.join(" ")}",signature="${bytesToBase64(new Uint8Array(signature))}"`,
  );
  return headers;
}
