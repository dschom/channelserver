import { randomBytes } from "node:crypto";

const CHANNELID_LEN = 16;

export class ChannelID {
  private readonly value: Buffer;

  private constructor(value: Buffer) {
    this.value = value;
  }

  static generate(): ChannelID {
    return new ChannelID(randomBytes(CHANNELID_LEN));
  }

  static fromString(encoded: string): ChannelID | null {
    const cleaned = encoded.replace(/=+$/, "");
    let buf: Buffer;
    try {
      buf = Buffer.from(cleaned, "base64url");
    } catch {
      return null;
    }
    if (buf.length < CHANNELID_LEN) {
      return null;
    }
    return new ChannelID(buf.subarray(0, CHANNELID_LEN));
  }

  toString(): string {
    return this.value.toString("base64url");
  }

  toJSON(): string {
    return this.toString();
  }

  equals(other: ChannelID): boolean {
    return this.value.equals(other.value);
  }

  /** Key for use in Maps. Stable string representation. */
  get key(): string {
    return this.toString();
  }
}
