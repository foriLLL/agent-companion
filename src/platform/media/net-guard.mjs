import { lookup as defaultDnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { MediaError } from "./errors.mjs";

// 媒体地址的 SSRF 收口：外部媒体（CDN、重定向目标）只能是公网 HTTPS，
// 解析结果不能落到本机、内网、链路本地或组播地址。

// 出现在查询串里的凭据参数名：日志、代理改写和回包里一律去掉。
export const SECRET_QUERY_KEYS = new Set([
  "api_key",
  "apikey",
  "access_token",
  "token",
  "x-emby-token"
]);

export function isPrivateAddress(address) {
  const normalized = String(address).toLowerCase().split("%")[0];
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }
  if (normalized.startsWith("fe") || normalized.startsWith("ff")) return true;
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
  if (isIP(normalized) !== 4) return false;
  const [a, b] = normalized.split(".").map(Number);
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224;
}

export async function resolveExternalMediaAddress(hostname, { dnsLookup = defaultDnsLookup } = {}) {
  const normalized = String(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(normalized)) {
    if (isPrivateAddress(normalized)) {
      throw new MediaError("UNSAFE_MEDIA_REDIRECT", "媒体重定向不能指向内网地址");
    }
    return { address: normalized, family: isIP(normalized) };
  }

  let addresses;
  try {
    addresses = await dnsLookup(normalized, { all: true, verbatim: true });
  } catch (cause) {
    throw new MediaError("MEDIA_REDIRECT_DNS_ERROR", "无法解析媒体 CDN 地址", {
      retryable: true,
      cause
    });
  }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new MediaError("UNSAFE_MEDIA_REDIRECT", "媒体 CDN 解析到了本机或内网地址");
  }
  const selected = addresses.find(({ family }) => Number(family) === 4) ?? addresses[0];
  return { address: selected.address, family: Number(selected.family) || isIP(selected.address) };
}

export async function validateExternalMediaUrl(input, { dnsLookup = defaultDnsLookup } = {}) {
  let url;
  try {
    url = new URL(input);
  } catch (cause) {
    throw new MediaError("UNSAFE_MEDIA_REDIRECT", "媒体重定向地址无效", { cause });
  }
  if (url.protocol !== "https:") {
    throw new MediaError("UNSAFE_MEDIA_REDIRECT", "跨源媒体重定向只允许 HTTPS");
  }
  if (url.username || url.password) {
    throw new MediaError("UNSAFE_MEDIA_REDIRECT", "媒体重定向不能包含用户名或密码");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new MediaError("UNSAFE_MEDIA_REDIRECT", "媒体重定向不能指向本机");
  }
  await resolveExternalMediaAddress(hostname, { dnsLookup });
  return url;
}
