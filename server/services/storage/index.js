// Object-storage abstraction (same pattern as the AI/STT/TTS/Telephony providers).
// STORAGE_PROVIDER = local (dev only) | s3  (AWS S3, Cloudflare R2, Backblaze B2, MinIO ...)
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

class LocalStorage {
  name = "local";
  supportsPresign = false;
  constructor() {
    this.base = path.resolve(process.env.STORAGE_LOCAL_DIR || "uploads/recordings");
  }
  resolve(key) {
    const full = path.resolve(this.base, key);
    if (!full.startsWith(this.base + path.sep)) throw new Error("Invalid storage key");
    return full;
  }
  async put(key, body) {
    const file = this.resolve(key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, body);
  }
  async stat(key) { return (await fsp.stat(this.resolve(key))).size; }
  createReadStream(key, opts) { return fs.createReadStream(this.resolve(key), opts); }
  async remove(key) { await fsp.rm(this.resolve(key), { force: true }); }
}

class S3Storage {
  name = "s3";
  supportsPresign = true;
  constructor(sdk, presign) {
    this.sdk = sdk;
    this.presign = presign;
    this.bucket = process.env.S3_BUCKET;
    this.client = new sdk.S3Client({
      region: process.env.S3_REGION || "auto",
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    });
  }
  async put(key, body, contentType) {
    await this.client.send(new this.sdk.PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: body, ContentType: contentType,
    }));
  }
  async getSignedUrl(key, { expiresIn = 300, contentType, download = false, filename = "recording" } = {}) {
    return this.presign(
      this.client,
      new this.sdk.GetObjectCommand({
        Bucket: this.bucket, Key: key,
        ResponseContentType: contentType,
        ResponseContentDisposition: download ? `attachment; filename="${String(filename).replace(/[^\w.\-]/g, "_")}"` : "inline",
      }),
      { expiresIn }
    );
  }
  async remove(key) {
    await this.client.send(new this.sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

let instance; // cached promise
export function getStorage() {
  if (!instance) instance = create();
  return instance;
}

async function create() {
  const provider = (process.env.STORAGE_PROVIDER || "local").toLowerCase();
  if (provider === "s3") {
    const missing = ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].filter((k) => !process.env[k]);
    if (missing.length) throw new Error(`STORAGE_PROVIDER=s3 but missing env: ${missing.join(", ")}`);
    // Loaded lazily so the app still boots in local mode without the AWS SDK installed.
    const sdk = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    return new S3Storage(sdk, getSignedUrl);
  }
  if (provider !== "local") throw new Error(`Unknown STORAGE_PROVIDER "${provider}"`);
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION !== "true") {
    // Never silently fall back to local disk in production: recordings would vanish on the next deploy.
    throw new Error("STORAGE_PROVIDER=local is not allowed in production. Set STORAGE_PROVIDER=s3 and the S3_* variables (Cloudflare R2 is S3-compatible).");
  }
  return new LocalStorage();
}
