export const APP_NAME = "Codex Relay";
export const ROUTER_HOST = "127.0.0.1";
export const ROUTER_PORT = 15723;
export const APP_DATA_DIR = ".codex-relay";
export const CONFIG_VERSION = 3;

export const LEGACY_OFFICIAL_SLOTS = [
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

export const THIRD_PARTY_SLOT_IDS = Array.from({ length: 10 }, (_, index) => `relay-third-party-${index + 1}`);

export const OFFICIAL_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

export const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  router: { host: ROUTER_HOST, port: ROUTER_PORT, running: false },
  official: {
    verified: false,
    lastCheckedAt: null,
    accountFingerprint: null,
    modelsFetchedAt: null,
    availableModels: [],
    slots: LEGACY_OFFICIAL_SLOTS,
  },
  contextCache: { persist: true },
  deepSeekSavings: { enabled: false },
  compactCapabilities: [],
  providers: [],
  thirdPartySlots: [],
};
