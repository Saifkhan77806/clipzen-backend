import { x25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const privateKey = randomBytes(32);
const publicKey = x25519.getPublicKey(privateKey);

mkdirSync("test-data", { recursive: true });

writeFileSync(
  "test-data/device-b-private-key.txt",
  Buffer.from(privateKey).toString("base64"),
  { mode: 0o600 },
);

console.log("Device B public key:");
console.log(Buffer.from(publicKey).toString("base64"));

console.log(
  "\nPrivate key saved locally to test-data/device-b-private-key.txt",
);