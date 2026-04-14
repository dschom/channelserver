export class HandlerError extends Error {
  constructor(
    public readonly kind: HandlerErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "HandlerError";
  }
}

export enum HandlerErrorKind {
  XSData = "XSData",
  XSMessage = "XSMessage",
  BadRemoteAddr = "BadRemoteAddr",
  IO = "IO",
  Metrics = "Metrics",
}

export function xsDataError(remote: string): HandlerError {
  return new HandlerError(
    HandlerErrorKind.XSData,
    `Excess Data Exchanged: ${remote}`,
  );
}

export function xsMessageError(remote: string): HandlerError {
  return new HandlerError(
    HandlerErrorKind.XSMessage,
    `Excess Messages: ${remote}`,
  );
}

export function badRemoteAddrError(reason: string): HandlerError {
  return new HandlerError(HandlerErrorKind.BadRemoteAddr, reason);
}
