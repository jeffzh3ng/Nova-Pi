/**
 * 微信 ilink CDN 上传：AES-128-ECB 加密 + POST 到 CDN。
 *
 * 参照 Tencent/openclaw-weixin (MIT) 的实现：
 *   1. 用随机 16 字节 AES key 对文件明文做 AES-128-ECB 加密（PKCS7 自动 padding）
 *   2. POST application/octet-stream 到 getUploadUrl 返回的 upload_full_url
 *   3. 响应头 x-encrypted-param 是下载凭证（encrypt_query_param）
 *   4. 发送消息时把 encrypt_query_param + aes_key(base64) 填进 file_item.media
 *
 * 关键细节（来自 openclaw-weixin）：
 *   - CDN 上传用 POST 不是 PUT
 *   - Content-Type: application/octet-stream
 *   - 响应的下载参数在 header `x-encrypted-param`，不在 body
 *   - 4xx 立即失败，5xx/网络错重试最多 3 次
 */

import { createCipheriv, randomBytes, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getUploadUrl } from "./weixin-api.js";

/** AES-128-ECB 加密（Node 自动加 PKCS7 padding）。 */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** AES-128-ECB 加密后的密文大小（PKCS7 padding 到 16 字节边界）。 */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

const UPLOAD_MAX_RETRIES = 3;

/**
 * 把一个 buffer 加密后 POST 到 CDN。
 * @returns 下载凭证 encrypt_query_param（来自响应头 x-encrypted-param）
 */
async function uploadBufferToCdn(params: {
  buf: Buffer;
  uploadFullUrl?: string;
  uploadParam?: string;
  filekey: string;
  cdnBaseUrl: string;
  aeskey: Buffer;
  label: string;
}): Promise<{ downloadParam: string }> {
  const { buf, uploadFullUrl, uploadParam, filekey, cdnBaseUrl, aeskey, label } = params;
  const ciphertext = encryptAesEcb(buf, aeskey);
  const trimmedFull = uploadFullUrl?.trim();
  // 优先用 upload_full_url；否则用 upload_param 按 openclaw-weixin 的格式拼 CDN URL：
  //   {cdnBaseUrl}/upload?encrypted_query_param={uploadParam}&filekey={filekey}
  const cdnUrl = trimmedFull || (uploadParam
    ? `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
    : "");
  if (!cdnUrl) {
    throw new Error(`${label}: CDN 上传地址缺失（需要 upload_full_url 或 upload_param）`);
  }

  let downloadParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get("x-error-message") ?? (await res.text().catch(() => ""));
        throw new Error(`CDN 客户端错误 ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get("x-error-message") ?? `status ${res.status}`;
        throw new Error(`CDN 服务端错误: ${errMsg}`);
      }
      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) {
        throw new Error("CDN 响应缺少 x-encrypted-param 头");
      }
      break;
    } catch (err) {
      lastError = err;
      // 4xx 客户端错误立即失败，不重试
      if (err instanceof Error && err.message.includes("客户端错误")) throw err;
      if (attempt < UPLOAD_MAX_RETRIES) {
        console.warn(`[weixin-cdn] ${label} 第 ${attempt} 次上传失败，重试...`);
      }
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`${label}: CDN 上传 ${UPLOAD_MAX_RETRIES} 次后仍失败`);
  }
  return { downloadParam };
}

/** 上传后的文件信息，用于构造 file_item 发送。 */
export type UploadedFileInfo = {
  /** 下载凭证（CDN 响应的 x-encrypted-param）。 */
  downloadEncryptedQueryParam: string;
  /** AES key 的 hex（发送时转 base64）。 */
  aeskeyHex: string;
  /** 原始（未加密）文件大小。 */
  fileSize: number;
  /** 加密后文件大小（密文）。 */
  fileSizeCiphertext: number;
};

/**
 * 完整上传流程：读文件 → 算 md5/size → 生成 aeskey → getUploadUrl → POST 到 CDN。
 * mediaType: 1=IMAGE, 2=VIDEO, 3=FILE, 4=VOICE（见 types.ts UploadMediaType）。
 */
export async function uploadMediaToCdn(params: {
  filePath: string;
  toUserId: string;
  baseUrl: string;
  token?: string;
  cdnBaseUrl: string;
  mediaType: number;
  label: string;
}): Promise<UploadedFileInfo> {
  const { filePath, toUserId, baseUrl, token, cdnBaseUrl, mediaType, label } = params;

  const plaintext = await readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = randomBytes(16).toString("hex");
  const aeskey = randomBytes(16);

  const uploadUrlResp = await getUploadUrl({
    baseUrl,
    token,
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });

  const uploadFullUrl = uploadUrlResp.upload_full_url?.trim() || undefined;
  const uploadParam = uploadUrlResp.upload_param ?? undefined;
  if (!uploadFullUrl && !uploadParam) {
    throw new Error(`${label}: getUploadUrl 未返回上传地址（upload_full_url 和 upload_param 均为空）`);
  }

  const { downloadParam } = await uploadBufferToCdn({
    buf: plaintext,
    uploadFullUrl,
    uploadParam,
    filekey,
    cdnBaseUrl,
    aeskey,
    label: `${label}[filekey=${filekey}]`,
  });

  return {
    downloadEncryptedQueryParam: downloadParam,
    aeskeyHex: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}
