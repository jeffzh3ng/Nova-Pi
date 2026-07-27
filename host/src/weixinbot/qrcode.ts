/**
 * 二维码工具：把 ilink 返回的二维码 URL 转成 base64 data URI。
 *
 * 背景：ilink 的 get_bot_qrcode 返回的 qrcode_img_content 是一个 URL，
 * 但访问该 URL 返回的是 HTML 页面（页面内用 JS 渲染二维码），不是图片。
 * 直接给前端 <img src=url> 无法渲染；且 Tauri 的 CSP（img-src 'self' data: ...）
 * 也会拦截外部 URL。
 *
 * 方案：用 qrcode 包，把 URL 内容本身编码成二维码 PNG，输出 data:image/png;base64,...
 * 前端 <img src="data:..."> 可直接显示，绕过 CSP。
 * 这与上游 Tencent/openclaw-weixin 的做法一致（它用 qrcode-terminal 生成终端二维码，
 * 编码内容就是这个 URL）。
 */

import QRCode from "qrcode";

/**
 * 把二维码内容（通常是 ilink 返回的 qrcode_img_content URL）转成 base64 data URI。
 * 失败时返回 null，调用方应回退到直接传 URL（让前端尝试）或报错。
 */
export async function toQrCodeDataUri(
  content: string,
  opts?: { width?: number; margin?: number },
): Promise<string | null> {
  try {
    const dataUri = await QRCode.toDataURL(content, {
      width: opts?.width ?? 240,
      margin: opts?.margin ?? 1,
      errorCorrectionLevel: "M",
    });
    return dataUri;
  } catch (err) {
    console.error("[weixinbot] 生成二维码 data URI 失败：", err);
    return null;
  }
}
