import assert from "node:assert/strict";
import test from "node:test";
import { embeddedIpv4, ipv6Words, isPrivateAddress, validateExternalMediaUrl } from "../src/platform/media/net-guard.mjs";

const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

test("IPv6 展开与内嵌 IPv4 提取", () => {
  assert.deepEqual(ipv6Words("::ffff:127.0.0.1"), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
  assert.deepEqual(ipv6Words("[2001:DB8::1]"), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
  assert.equal(ipv6Words("127.0.0.1"), null);
  assert.equal(embeddedIpv4("::ffff:7f00:1"), "127.0.0.1");
  assert.equal(embeddedIpv4("::ffff:0:a9fe:a9fe"), "169.254.169.254");
  assert.equal(embeddedIpv4("::127.0.0.1"), "127.0.0.1");
  assert.equal(embeddedIpv4("64:ff9b::a00:1"), "10.0.0.1");
  assert.equal(embeddedIpv4("2002:c0a8:101::"), "192.168.1.1");
  assert.equal(embeddedIpv4("2606:4700::1111"), null);
});

test("isPrivateAddress 拦截 IPv4 映射等变体，放行公网 IPv6", () => {
  for (const address of [
    "::1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::127.0.0.1",
    "64:ff9b::127.0.0.1", "2002:7f00:1::", "fe81::1", "fec0::1", "fd00::1", "fc00::1", "ff02::1", "fe80::1%en0"
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["2606:4700::1111", "::ffff:93.184.216.34", "2002:5db8:d822::", "93.184.216.34"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test("validateExternalMediaUrl 拒绝括号里的 IPv4 映射地址与带末尾点的 localhost", async () => {
  for (const url of [
    "https://[::ffff:127.0.0.1]/v.mp4",
    "https://[::ffff:169.254.169.254]/latest/meta-data",
    "https://[::127.0.0.1]/",
    "https://[64:ff9b::127.0.0.1]/",
    "https://localhost./",
    "https://media.localhost./"
  ]) {
    await assert.rejects(validateExternalMediaUrl(url, { dnsLookup: publicDns }), { code: "UNSAFE_MEDIA_REDIRECT" }, url);
  }
  await assert.doesNotReject(validateExternalMediaUrl("https://[2606:4700::1111]/v.mp4", { dnsLookup: publicDns }));
});
