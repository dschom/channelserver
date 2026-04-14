const PREFIX = "PAIR";

export interface Settings {
  hostname: string;
  port: number;
  max_channel_connections: number;
  conn_lifespan: number;
  client_timeout: number;
  heartbeat_interval: number;
  max_exchanges: number;
  max_data: number;
  debug: boolean;
  verbose: boolean;
  mmdb_loc: string;
  statsd_host: string;
  trusted_proxy_list: string;
  human_logs: boolean;
  default_lang: string;
  metric_name: string;
}

const DEFAULTS: Settings = {
  hostname: "0.0.0.0",
  port: 8000,
  max_channel_connections: 3,
  conn_lifespan: 300,
  client_timeout: 60,
  heartbeat_interval: 5,
  max_exchanges: 10,
  max_data: 0,
  debug: false,
  verbose: false,
  mmdb_loc: "mmdb/latest/GeoLite2-City.mmdb",
  statsd_host: "localhost:8125",
  trusted_proxy_list: "",
  human_logs: false,
  default_lang: "en",
  metric_name: "channelserver",
};

function envStr(key: string): string | undefined {
  return process.env[`${PREFIX}_${key.toUpperCase()}`];
}

function envNum(key: string): number | undefined {
  const v = envStr(key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

function envBool(key: string): boolean | undefined {
  const v = envStr(key);
  if (v === undefined) return undefined;
  return v === "true" || v === "1";
}

export function loadSettings(): Settings {
  return {
    hostname: envStr("hostname") ?? DEFAULTS.hostname,
    port: envNum("port") ?? DEFAULTS.port,
    max_channel_connections:
      envNum("max_channel_connections") ?? DEFAULTS.max_channel_connections,
    conn_lifespan: envNum("conn_lifespan") ?? DEFAULTS.conn_lifespan,
    client_timeout: envNum("client_timeout") ?? DEFAULTS.client_timeout,
    heartbeat_interval:
      envNum("heartbeat_interval") ?? DEFAULTS.heartbeat_interval,
    max_exchanges: envNum("max_exchanges") ?? DEFAULTS.max_exchanges,
    max_data: envNum("max_data") ?? DEFAULTS.max_data,
    debug: envBool("debug") ?? DEFAULTS.debug,
    verbose: envBool("verbose") ?? DEFAULTS.verbose,
    mmdb_loc: envStr("mmdb_loc") ?? DEFAULTS.mmdb_loc,
    statsd_host: envStr("statsd_host") ?? DEFAULTS.statsd_host,
    trusted_proxy_list:
      envStr("trusted_proxy_list") ?? DEFAULTS.trusted_proxy_list,
    human_logs: envBool("human_logs") ?? DEFAULTS.human_logs,
    default_lang: envStr("default_lang") ?? DEFAULTS.default_lang,
    metric_name: envStr("metric_name") ?? DEFAULTS.metric_name,
  };
}
