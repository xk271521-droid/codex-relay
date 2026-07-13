export const APP_NAME = "Codex Relay";
export const ROUTER_HOST = "127.0.0.1";
export const ROUTER_PORT = 15723;
export const APP_DATA_DIR = ".codex-relay";
export const CONFIG_VERSION = 1;

export const OFFICIAL_SLOTS = [
  {
    id: "gpt-5.6-terra",
    displayName: "5.6 Terra",
    upstreamModel: "gpt-5.6-terra",
    description: "Uses the signed-in Codex account when verified.",
  },
  {
    id: "gpt-5.5",
    displayName: "5.5",
    upstreamModel: "gpt-5.5",
    description: "Uses the signed-in Codex account when verified.",
  },
];

export const THIRD_PARTY_SLOT_IDS = [
  "relay-third-party-1",
  "relay-third-party-2",
  "relay-third-party-3",
  "relay-third-party-4",
  "relay-third-party-5",
];

export const OFFICIAL_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

export const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  router: { host: ROUTER_HOST, port: ROUTER_PORT, running: false },
  official: { verified: false, lastCheckedAt: null },
  contextCache: { persist: false },
  providers: [],
  thirdPartySlots: [],
};
