import StatsD from "hot-shots";
import type { Logger } from "./logging.js";
import type { Settings } from "./settings.js";

export type MetricsClient = InstanceType<typeof StatsD>;

export function createMetrics(settings: Settings, log: Logger): MetricsClient {
  const [host, portStr] = settings.statsd_host.split(":");
  const port = parseInt(portStr, 10) || 8125;

  return new StatsD({
    host: host || "localhost",
    port,
    prefix: `${settings.metric_name}.`,
    errorHandler(err) {
      log.warn({ err }, "StatsD error");
    },
  });
}
