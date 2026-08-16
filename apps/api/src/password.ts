const encoder = new TextEncoder();

export const PASSWORD_ALGORITHM = "pbkdf2-sha256" as const;
// Cloudflare Workers Web Crypto rejects PBKDF2 requests above 100,000
// iterations. Rate limits and Turnstile bound the online attack surface.
export const PASSWORD_ITERATIONS = 100_000;

export function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomPasswordSalt() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

function hexToBytes(value: string) {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) {
    throw new Error("Invalid hexadecimal password material");
  }
  return new Uint8Array(value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
}

export async function derivePasswordHash(
  password: string,
  saltHex: string,
  iterations = PASSWORD_ITERATIONS,
) {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: hexToBytes(saltHex),
      iterations,
    },
    material,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export function constantTimeHexEqual(left: string, right: string) {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  if (normalizedLeft.length !== normalizedRight.length) return false;
  let difference = 0;
  for (let index = 0; index < normalizedLeft.length; index += 1) {
    difference |= normalizedLeft.charCodeAt(index) ^ normalizedRight.charCodeAt(index);
  }
  return difference === 0;
}
