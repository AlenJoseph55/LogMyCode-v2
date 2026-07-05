import * as crypto from "crypto";

/**
 * Encrypts cleartext using AES-256-GCM.
 * Returns a colon-separated string of hex values: iv:authTag:ciphertext
 */
export function encrypt(text: string, keyHex: string): string {
  const iv = crypto.randomBytes(12);
  const key = Buffer.from(keyHex, "hex");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM encrypted string (format: iv:authTag:ciphertext).
 */
export function decrypt(encryptedText: string, keyHex: string): string {
  const parts = encryptedText.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted format. Expected iv:authTag:ciphertext");
  }
  
  const [ivHex, authTagHex, encrypted] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const key = Buffer.from(keyHex, "hex");
  
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * Checks if a string is in the expected encrypted format (iv:authTag:ciphertext)
 */
export function isEncrypted(text: string): boolean {
  if (!text) return false;
  const parts = text.split(":");
  return parts.length === 3 && parts[0].length === 24 && parts[1].length === 32;
}
