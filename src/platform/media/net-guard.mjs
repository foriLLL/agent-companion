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

/** 把 IPv6 文本展开成 8 个 16 位整数；不是合法 IPv6 时返回 null。 */
export function ipv6Words(address) {
  const text = String(address).toLowerCase().split("%")[0].replace(/^\[|\]$/g, "");
  if (isIP(text) !== 6) return null;
  // 先交给 WHATWG URL 规范化：内嵌的点分 IPv4 会变成十六进制，大小写与前导零统一。
  let canonical;
  try {
    canonical = new URL(`http://[${text}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const parse = (part) => (part ? part.split(":").map((word) => Number.parseInt(word, 16)) : []);
  const [head, tail] = canonical.split("::");
  const left = parse(head);
  if (tail === undefined) return left.length === 8 ? left : null;
  const right = parse(tail);
  const gap = 8 - left.length - right.length;
  return gap < 0 ? null : [...left, ...new Array(gap).fill(0), ...right];
}

/**
 * IPv6 地址里内嵌的 IPv4：IPv4 映射（::ffff:0:0/96）、SIIT（::ffff:0:0:0/96）、
 * 已废弃的兼容地址（::/96）、NAT64（64:ff9b::/96）与 6to4（2002::/16）。没有时返回 null。
 */
export function embeddedIpv4(address) {
  const words = Array.isArray(address) ? address : ipv6Words(address);
  if (!words) return null;
  const ipv4 = (high, low) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  const zero = (from, to) => words.slice(from, to).every((word) => word === 0);
  if (zero(0, 5) && words[5] === 0xffff) return ipv4(words[6], words[7]);
  if (zero(0, 4) && words[4] === 0xffff && words[5] === 0) return ipv4(words[6], words[7]);
  if (zero(0, 6)) return ipv4(words[6], words[7]);
  if (words[0] === 0x64 && words[1] === 0xff9b && zero(2, 6)) return ipv4(words[6], words[7]);
  if (words[0] === 0x2002) return ipv4(words[1], words[2]);
  return null;
}

export function isPrivateAddress(address) {
  const normalized = String(address).toLowerCase().split("%")[0].replace(/^\[|\]$/g, "");
  if (isIP(normalized) === 6) {
    const words = ipv6Words(normalized);
    if (!words) return true;
    const embedded = embeddedIpv4(words);
    // ::、::1 落在兼容地址段，内嵌的 0.0.0.0 / 0.0.0.1 按 IPv4 规则同样拒绝。
    if (embedded) return isPrivateAddress(embedded);
    const first = words[0];
    return (first & 0xfe00) === 0xfc00 // fc00::/7 唯一本地
      || (first & 0xff00) === 0xfe00 // fe00::/8 链路本地与已废弃的站点本地
      || (first & 0xff00) === 0xff00; // ff00::/8 组播
  }
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
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new MediaError("UNSAFE_MEDIA_REDIRECT", "媒体重定向不能指向本机");
  }
  await resolveExternalMediaAddress(hostname, { dnsLookup });
  return url;
}
