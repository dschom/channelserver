import { type IncomingMessage } from "node:http";
import { type Reader } from "@maxmind/geoip2-node";
import type { Logger } from "./logging.js";
import { badRemoteAddrError } from "./error.js";
import net from "node:net";

export interface SenderData {
  ua?: string;
  remote?: string;
  city?: string;
  region?: string;
  country?: string;
}

interface TrustedNet {
  prefix: string;
  bits: number;
  addr: number[];
}

const LANGUAGES = ["en", "fr", "de", "ja", "pt-BR", "ru", "zh-CN"] as const;

// Parse a CIDR string into a prefix/mask struct for matching
function parseCIDR(cidr: string): TrustedNet | null {
  const [prefix, bitsStr] = cidr.split("/");
  if (!prefix || !bitsStr) return null;
  const bits = parseInt(bitsStr, 10);
  if (Number.isNaN(bits)) return null;
  const addr = parseIPToNumbers(prefix);
  if (!addr) return null;
  return { prefix, bits, addr };
}

function parseIPToNumbers(ip: string): number[] | null {
  if (net.isIPv4(ip)) {
    return ip.split(".").map(Number);
  }
  if (net.isIPv6(ip)) {
    // Expand IPv6 to 8 groups of 16 bits
    let full = ip;
    // Handle IPv4-mapped IPv6 (::ffff:1.2.3.4)
    const v4mapped = full.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (v4mapped) {
      const v4parts = v4mapped[1].split(".").map(Number);
      return [0, 0, 0, 0, 0, 0xffff, (v4parts[0] << 8) | v4parts[1], (v4parts[2] << 8) | v4parts[3]];
    }

    if (full.includes("::")) {
      const [left, right] = full.split("::");
      const leftParts = left ? left.split(":") : [];
      const rightParts = right ? right.split(":") : [];
      const missing = 8 - leftParts.length - rightParts.length;
      const middle = new Array(missing).fill("0");
      full = [...leftParts, ...middle, ...rightParts].join(":");
    }
    const parts = full.split(":").map((s) => parseInt(s, 16));
    if (parts.length !== 8 || parts.some(Number.isNaN)) return null;
    return parts;
  }
  return null;
}

function ipMatchesCIDR(ip: string, network: TrustedNet): boolean {
  const addr = parseIPToNumbers(ip);
  if (!addr) return false;
  // Both must be same address family (4 parts = v4, 8 parts = v6)
  if (addr.length !== network.addr.length) {
    // Check if one is IPv4-mapped IPv6 vs IPv4
    if (addr.length === 4 && network.addr.length === 8) {
      // Check if network is a v4 network represented in v6 (unlikely in our case)
      return false;
    }
    if (addr.length === 8 && network.addr.length === 4) {
      return false;
    }
    return false;
  }
  const bitsPerPart = addr.length === 4 ? 8 : 16;
  let remaining = network.bits;
  for (let i = 0; i < addr.length && remaining > 0; i++) {
    const partBits = Math.min(remaining, bitsPerPart);
    const mask = ((1 << partBits) - 1) << (bitsPerPart - partBits);
    if ((addr[i] & mask) !== (network.addr[i] & mask)) {
      return false;
    }
    remaining -= partBits;
  }
  return true;
}

export function buildTrustedProxyList(configList: string): TrustedNet[] {
  const nets: TrustedNet[] = [];
  // Private networks
  for (const cidr of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]) {
    const parsed = parseCIDR(cidr);
    if (parsed) nets.push(parsed);
  }
  if (configList) {
    for (let proxy of configList.split(",")) {
      proxy = proxy.trim();
      if (!proxy) continue;
      if (!proxy.includes("/")) {
        proxy = `${proxy}/32`;
      }
      const parsed = parseCIDR(proxy);
      if (parsed) {
        nets.push(parsed);
      }
    }
  }
  return nets;
}

function isTrustedProxy(proxyList: TrustedNet[], ip: string): boolean {
  return proxyList.some((net) => ipMatchesCIDR(ip, net));
}

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("127.");
}

export function getRemote(
  peer: string | undefined,
  headers: IncomingMessage["headers"],
  proxyList: TrustedNet[],
  log: Logger,
): string | null {
  if (!peer) {
    log.error("Peer is unspecified");
    return null;
  }

  // If the peer is not a known proxy, ignore X-Forwarded-For
  if (!isTrustedProxy(proxyList, peer)) {
    return peer;
  }

  // Peer is a trusted proxy — take rightmost non-proxy X-Forwarded-For
  const xff = headers["x-forwarded-for"];
  if (!xff) {
    log.error("No X-Forwarded-For found for proxied connection");
    return null;
  }

  const xffStr = Array.isArray(xff) ? xff.join(",") : xff;
  log.info({ remote_ip_list: xffStr }, "Remote IP List");

  const hostList = xffStr.split(",").map((s) => s.trim());
  // Walk from right to left, find first non-proxy, non-loopback
  for (let i = hostList.length - 1; i >= 0; i--) {
    const host = hostList[i];
    if (!net.isIP(host)) {
      log.info({ remote_ip: host }, "Bad IP Specified");
      return null;
    }
    if (!isLoopback(host) && !isTrustedProxy(proxyList, host)) {
      return host;
    }
  }

  log.error("Only proxies specified in X-Forwarded-For");
  return null;
}

// Language preference parsing from Accept-Language header
function preferredLanguages(header: string, defaultLang: string): string[] {
  const tree = new Map<string, string>();
  let i = 0;
  for (const part of header.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "-") continue;
    if (trimmed.includes(";")) {
      const [lang, pref] = trimmed.split(";").map((s) => s.trim().toLowerCase());
      tree.set(pref, lang);
    } else {
      tree.set(`q=1.${String(i).padStart(2, "0")}`, trimmed.toLowerCase());
      i++;
    }
  }
  // BTreeMap in Rust sorts by key ascending; reverse for descending priority
  const sorted = [...tree.entries()].sort(([a], [b]) => a.localeCompare(b));
  const langs = sorted.map(([, v]) => v).reverse();
  langs.push(defaultLang);
  return langs;
}

function getNameForLanguage(
  lang: string,
  names: Record<string, string> | undefined,
): string | undefined {
  if (!names) return undefined;
  const key = lang.toLowerCase();
  const langMap: Record<string, string> = {
    en: "en",
    fr: "fr",
    ge: "de",
    de: "de",
    jp: "ja",
    ja: "ja",
    "pt-br": "pt-BR",
    ru: "ru",
    "zh-cn": "zh-CN",
  };
  const mmKey = langMap[key];
  if (mmKey) return names[mmKey];
  return undefined;
}

function getPreferredLanguageElement(
  langs: string[],
  names: Record<string, string> | undefined,
): string | undefined {
  if (!names) return undefined;
  for (const lang of langs) {
    if (lang === "*" || lang === "-") {
      for (const l of LANGUAGES) {
        const name = names[l];
        if (name) return name;
      }
      return undefined;
    }
    const name = getNameForLanguage(lang, names);
    if (name) return name;
    if (lang.includes("-")) {
      const root = lang.split("-")[0];
      const rootName = getNameForLanguage(root, names);
      if (rootName) return rootName;
    }
  }
  return undefined;
}

export function buildSenderData(
  req: IncomingMessage,
  peerIp: string | undefined,
  proxyList: TrustedNet[],
  iploc: Reader | null,
  defaultLang: string,
  log: Logger,
): SenderData {
  const sender: SenderData = {};

  // Resolve remote IP
  sender.remote = getRemote(peerIp, req.headers, proxyList, log) ?? undefined;

  // Parse Accept-Language
  const alHeader = req.headers["accept-language"] ?? defaultLang;
  const langs = preferredLanguages(alHeader, defaultLang);

  // User-Agent
  const ua = req.headers["user-agent"];
  if (ua) sender.ua = ua;

  // GeoIP lookup
  if (sender.remote && iploc) {
    try {
      // Reader.city() is available on buffer-opened readers
      const result = (iploc as any).city(sender.remote);
      if (result.city?.names) {
        sender.city = getPreferredLanguageElement(langs, result.city.names);
      }
      if (result.country?.names) {
        sender.country = getPreferredLanguageElement(langs, result.country.names);
      }
      if (result.subdivisions && result.subdivisions.length > 0) {
        sender.region = getPreferredLanguageElement(
          langs,
          result.subdivisions[0].names,
        );
      }
    } catch {
      log.info({ remote_ip: sender.remote }, "No location info for IP");
    }
  }

  // Fallback: X-Client-Geo-Location (only trust from proxied connections)
  if (!sender.city) {
    const geoHeader = req.headers["x-client-geo-location"];
    if (
      geoHeader &&
      typeof geoHeader === "string" &&
      peerIp &&
      isTrustedProxy(proxyList, peerIp)
    ) {
      const bits = geoHeader.split(",");
      if (bits.length >= 1) sender.region = bits[0];
      if (bits.length >= 2) sender.city = bits[1];
    }
  }

  return sender;
}
