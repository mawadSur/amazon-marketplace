// S3-compatible object storage (works with AWS S3 and Cloudflare R2).
// Provides:
//   - signed PUT URLs for direct browser uploads
//   - signed GET URLs for short-lived private reads
//   - public URL helper for already-public objects
//
// All getters lazy-construct the client so missing creds only fail at the
// callsite, not at import time.

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";

let _client: S3Client | null = null;

function client(): S3Client {
  if (_client) return _client;
  if (!env.S3_BUCKET) {
    throw new Error("Object storage not configured (S3_BUCKET).");
  }
  // Explicit keys are for external R2/MinIO (paired with S3_ENDPOINT). On AWS we
  // deliberately set NO static keys and let the SDK's default credential provider
  // chain resolve the ECS task role — which the CDK grants S3 read/write + KMS
  // encrypt/decrypt on the bucket. Requiring static keys here would both defeat
  // that and fail on the KMS-encrypted bucket.
  const hasExplicitKeys = Boolean(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);
  _client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT || undefined,
    forcePathStyle: !!env.S3_ENDPOINT, // R2/MinIO style
    ...(hasExplicitKeys
      ? {
          credentials: {
            accessKeyId: env.S3_ACCESS_KEY_ID as string,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY as string,
          },
        }
      : {}),
  });
  return _client;
}

export async function signedUploadUrl(key: string, contentType: string, ttlSeconds = 300) {
  if (!env.S3_BUCKET) throw new Error("S3_BUCKET not set");
  const cmd = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(client(), cmd, { expiresIn: ttlSeconds });
}

export async function signedReadUrl(key: string, ttlSeconds = 300) {
  if (!env.S3_BUCKET) throw new Error("S3_BUCKET not set");
  const cmd = new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key });
  return getSignedUrl(client(), cmd, { expiresIn: ttlSeconds });
}

/**
 * Server-side upload of raw bytes (e.g. an AI worker re-hosting a generated
 * asset). Browser uploads should use `signedUploadUrl` instead.
 */
export async function putObject(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
): Promise<void> {
  if (!env.S3_BUCKET) throw new Error("S3_BUCKET not set");
  await client().send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export function publicUrl(key: string) {
  if (env.S3_PUBLIC_BASE_URL) return `${env.S3_PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`;
  if (env.S3_ENDPOINT && env.S3_BUCKET) {
    return `${env.S3_ENDPOINT.replace(/\/$/, "")}/${env.S3_BUCKET}/${key}`;
  }
  throw new Error("No public base URL configured (set S3_PUBLIC_BASE_URL).");
}

export function buildKey(parts: { shopId: string; productId?: string; kind: string; ext: string }) {
  const id = parts.productId ?? "noproduct";
  return `shops/${parts.shopId}/${id}/${parts.kind}/${crypto.randomUUID()}.${parts.ext}`;
}
