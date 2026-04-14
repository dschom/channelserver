import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(human: boolean): Logger {
  if (human) {
    return pino({
      transport: {
        target: "pino/file",
        options: { destination: 1 },
      },
      level: "debug",
    });
  }
  return pino({ level: "debug" });
}
