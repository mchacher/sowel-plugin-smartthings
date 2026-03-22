/**
 * Sowel Plugin: Samsung SmartThings
 *
 * Integrates Samsung SmartThings devices via the SmartThings REST API.
 * Uses a Personal Access Token (PAT) for authentication and polling for data updates.
 *
 * Supported device types:
 * - Samsung OCF TV → media_player (power, volume, mute, input source, picture mode)
 * - Samsung OCF Washer → appliance (power, state, phase, progress, remaining time, energy)
 * - Other devices → generic sensor data
 */

// ============================================================
// Types — mirrors Sowel's plugin API without importing
// ============================================================

interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  trace(obj: Record<string, unknown>, msg: string): void;
}

interface SettingsManager {
  get(key: string): string | undefined;
}

interface DeviceManager {
  upsertFromDiscovery(
    integrationId: string,
    source: string,
    devices: DiscoveredDevice[],
  ): void;
  updateDeviceData(
    integrationId: string,
    sourceDeviceId: string,
    key: string,
    value: unknown,
    meta?: { type?: string; category?: string; unit?: string },
  ): void;
}

interface DiscoveredDevice {
  sourceDeviceId: string;
  friendlyName: string;
  manufacturer?: string;
  model?: string;
  data?: Array<{
    key: string;
    value: unknown;
    type?: string;
    category?: string;
    unit?: string;
  }>;
  orders?: Array<{
    key: string;
    type: string;
    enumValues?: string[];
    min?: number;
    max?: number;
  }>;
}

interface EventBus {
  on(handler: (event: unknown) => void): () => void;
}

interface IntegrationSettingDef {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean";
  required: boolean;
  placeholder?: string;
  defaultValue?: string;
}

type IntegrationStatus = "connected" | "disconnected" | "not_configured" | "error";

interface IntegrationPlugin {
  id: string;
  name: string;
  description: string;
  icon: string;
  getSettings(): IntegrationSettingDef[];
  getStatus(): IntegrationStatus;
  isConfigured(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  executeOrder?(deviceSourceId: string, key: string, value: unknown): Promise<void>;
  getPollingInfo?(): { lastPollAt: string; intervalMs: number } | null;
}

interface PluginDeps {
  logger: Logger;
  settingsManager: SettingsManager;
  deviceManager: DeviceManager;
  eventBus: EventBus;
  pluginDir: string;
}

type PluginFactory = (deps: PluginDeps) => IntegrationPlugin;

// ============================================================
// SmartThings API types
// ============================================================

interface STDevice {
  deviceId: string;
  label?: string;
  name: string;
  deviceTypeName: string;
  manufacturerName?: string;
  components: Array<{
    id: string;
    capabilities: Array<{ id: string; version: number }>;
  }>;
}

interface STDeviceStatus {
  components: Record<string, Record<string, Record<string, { value: unknown }>>>;
}

// ============================================================
// Constants
// ============================================================

const INTEGRATION_ID = "smartthings";
const API_BASE = "https://api.smartthings.com/v1";
const MIN_POLL_INTERVAL = 60_000;
const DEFAULT_POLL_INTERVAL = 300_000;

const SETTINGS: IntegrationSettingDef[] = [
  {
    key: "token",
    label: "Personal Access Token (PAT)",
    type: "password",
    required: true,
    placeholder: "Generate at account.smartthings.com/tokens",
  },
  {
    key: "polling_interval",
    label: "Polling interval (seconds)",
    type: "number",
    required: false,
    defaultValue: "300",
    placeholder: "Min 60, default 300",
  },
];

// ============================================================
// Plugin implementation
// ============================================================

export function createPlugin(deps: PluginDeps): IntegrationPlugin {
  const { logger, settingsManager, deviceManager } = deps;

  let status: IntegrationStatus = "disconnected";
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastPollAt: string | null = null;
  let pollIntervalMs = DEFAULT_POLL_INTERVAL;

  // Known devices from last discovery
  const knownDevices = new Map<string, STDevice>();

  // ── Helpers ──────────────────────────────────────────────

  function getSetting(key: string): string | undefined {
    return settingsManager.get(`integration.${INTEGRATION_ID}.${key}`);
  }

  function getToken(): string {
    const token = getSetting("token");
    if (!token) throw new Error("SmartThings PAT not configured");
    return token;
  }

  async function apiGet<T>(path: string): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${getToken()}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`SmartThings API ${res.status}: ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  async function apiPost(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SmartThings command failed ${res.status}: ${text}`);
    }
  }

  // ── Device type detection ────────────────────────────────

  function isTV(device: STDevice): boolean {
    return device.deviceTypeName.includes("TV");
  }

  function isWasher(device: STDevice): boolean {
    return device.deviceTypeName.includes("Washer");
  }

  // ── Discovery ────────────────────────────────────────────

  function buildDiscoveredDevice(device: STDevice): DiscoveredDevice {
    const discovered: DiscoveredDevice = {
      sourceDeviceId: device.label ?? device.name,
      friendlyName: device.label ?? device.name,
      manufacturer: device.manufacturerName ?? "Samsung",
      model: device.deviceTypeName,
      data: [],
      orders: [],
    };

    if (isTV(device)) {
      discovered.data = [
        { key: "power", value: null, type: "boolean", category: "generic" },
        { key: "volume", value: null, type: "number", category: "generic" },
        { key: "mute", value: null, type: "boolean", category: "generic" },
        { key: "input_source", value: null, type: "enum", category: "generic" },
        { key: "picture_mode", value: null, type: "enum", category: "generic" },
      ];
      discovered.orders = [
        { key: "power", type: "boolean" },
        { key: "volume", type: "number", min: 0, max: 100 },
        { key: "mute", type: "boolean" },
        { key: "input_source", type: "enum", enumValues: [] },
      ];
    } else if (isWasher(device)) {
      discovered.data = [
        { key: "power", value: null, type: "boolean", category: "generic" },
        { key: "state", value: null, type: "enum", category: "generic" },
        { key: "job_phase", value: null, type: "enum", category: "generic" },
        { key: "progress", value: null, type: "number", category: "generic", unit: "%" },
        { key: "remaining_time", value: null, type: "number", category: "generic", unit: "min" },
        { key: "remaining_time_str", value: null, type: "text", category: "generic" },
        { key: "energy", value: null, type: "number", category: "energy", unit: "Wh" },
      ];
    } else {
      // Generic: expose power if switch capability present
      const hasSwitchCap = device.components.some((c) =>
        c.capabilities.some((cap) => cap.id === "switch"),
      );
      if (hasSwitchCap) {
        discovered.data = [
          { key: "power", value: null, type: "boolean", category: "generic" },
        ];
      }
    }

    return discovered;
  }

  async function discover(): Promise<void> {
    const result = await apiGet<{ items: STDevice[] }>("/devices");
    const devices = result.items;

    knownDevices.clear();
    const discovered: DiscoveredDevice[] = [];

    for (const device of devices) {
      knownDevices.set(device.deviceId, device);
      discovered.push(buildDiscoveredDevice(device));
    }

    deviceManager.upsertFromDiscovery(INTEGRATION_ID, "smartthings", discovered);
    logger.info({ count: devices.length }, "SmartThings devices discovered");
  }

  // ── Status extraction ────────────────────────────────────

  function getAttr(
    main: Record<string, Record<string, { value: unknown }>>,
    capability: string,
    attribute: string,
  ): unknown {
    return main[capability]?.[attribute]?.value ?? null;
  }

  function updateTV(deviceLabel: string, main: Record<string, Record<string, { value: unknown }>>): void {
    const switchVal = getAttr(main, "switch", "switch");
    deviceManager.updateDeviceData(INTEGRATION_ID, deviceLabel, "power", switchVal === "on", {
      type: "boolean",
      category: "generic",
    });

    const volume = getAttr(main, "audioVolume", "volume");
    if (typeof volume === "number") {
      deviceManager.updateDeviceData(INTEGRATION_ID, deviceLabel, "volume", volume, {
        type: "number",
        category: "generic",
      });
    }

    const mute = getAttr(main, "audioMute", "mute");
    deviceManager.updateDeviceData(INTEGRATION_ID, deviceLabel, "mute", mute === "muted", {
      type: "boolean",
      category: "generic",
    });

    // Prefer samsungvd.mediaInputSource over standard
    const inputSource =
      getAttr(main, "samsungvd.mediaInputSource", "inputSource") ??
      getAttr(main, "mediaInputSource", "inputSource");
    if (inputSource !== null) {
      deviceManager.updateDeviceData(INTEGRATION_ID, deviceLabel, "input_source", inputSource, {
        type: "enum",
        category: "generic",
      });
    }

    const pictureMode = getAttr(main, "custom.picturemode", "pictureMode");
    if (pictureMode !== null) {
      deviceManager.updateDeviceData(INTEGRATION_ID, deviceLabel, "picture_mode", pictureMode, {
        type: "enum",
        category: "generic",
      });
    }
  }

  function updateWasher(deviceLabel: string, main: Record<string, Record<string, { value: unknown }>>): void {
    const switchVal = getAttr(main, "switch", "switch");
    deviceManager.updateDeviceData(INTEGRATION_ID, deviceLabel, "power", switchVal === "on", {
      type: "boolean",
      category: "generic",
    });

    // Prefer samsungce operating state
    const operatingState =
      getAttr(main, "samsungce.washerOperatingState", "operatingState") ??
      getAttr(main, "washerOperatingState", "machineState");
    if (operatingState !== null) {
      deviceManager.updateDeviceData(INTEGRATION_ID, deviceLabel, "state", operatingState, {
        type: "enum",
        category: "generic",
      });
    }

    const jobPhase =
      getAttr(main, "samsungce.washerOperatingState", "washerJobPhase") ??
      getAttr(main, "washerOperatingState", "washerJobState");
    if (jobPhase !== null) {
      deviceManager.updateDeviceData(INTEGRATION_ID, deviceLabel, "job_phase", jobPhase, {
        type: "enum",
        category: "generic",
      });
    }

    const progress = getAttr(main, "samsungce.washerOperatingState", "progress");
    if (typeof progress === "number") {
      deviceManager.updateDeviceData(INTEGRATION_ID, deviceLabel, "progress", progress, {
        type: "number",
        category: "generic",
        unit: "%",
      });
    }

    const remainingTime = getAttr(main, "samsungce.washerOperatingState", "remainingTime");
    if (typeof remainingTime === "number") {
      deviceManager.updateDeviceData(INTEGRATION_ID, deviceLabel, "remaining_time", remainingTime, {
        type: "number",
        category: "generic",
        unit: "min",
      });
    }

    const remainingTimeStr = getAttr(main, "samsungce.washerOperatingState", "remainingTimeStr");
    if (remainingTimeStr !== null) {
      deviceManager.updateDeviceData(INTEGRATION_ID, deviceLabel, "remaining_time_str", String(remainingTimeStr), {
        type: "text",
        category: "generic",
      });
    }

    // Energy
    const powerConsumption = getAttr(main, "powerConsumptionReport", "powerConsumption") as {
      energy?: number;
    } | null;
    if (powerConsumption?.energy !== undefined) {
      deviceManager.updateDeviceData(INTEGRATION_ID, deviceLabel, "energy", powerConsumption.energy, {
        type: "number",
        category: "energy",
        unit: "Wh",
      });
    }
  }

  // ── Poll cycle ───────────────────────────────────────────

  async function poll(): Promise<void> {
    try {
      // Re-discover to catch new/removed devices
      await discover();

      // Poll status for each known device
      for (const [deviceId, device] of knownDevices) {
        try {
          const deviceStatus = await apiGet<STDeviceStatus>(`/devices/${deviceId}/status`);
          const main = deviceStatus.components?.main;
          if (!main) continue;

          const deviceLabel = device.label ?? device.name;

          if (isTV(device)) {
            updateTV(deviceLabel, main);
          } else if (isWasher(device)) {
            updateWasher(deviceLabel, main);
          } else {
            // Generic: just update power
            const switchVal = getAttr(main, "switch", "switch");
            if (switchVal !== null) {
              deviceManager.updateDeviceData(INTEGRATION_ID, deviceLabel, "power", switchVal === "on", {
                type: "boolean",
                category: "generic",
              });
            }
          }
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? { message: err.message } : {}, deviceId },
            "Failed to poll device status",
          );
        }
      }

      lastPollAt = new Date().toISOString();
      if (status !== "connected") {
        status = "connected";
      }

      logger.debug({ devices: knownDevices.size }, "SmartThings poll complete");
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? { message: err.message } : {} },
        "SmartThings poll failed",
      );
      status = "error";
    }
  }

  // ── Order execution ──────────────────────────────────────

  async function executeOrder(deviceSourceId: string, key: string, value: unknown): Promise<void> {
    // Find device by label
    let targetDeviceId: string | null = null;
    for (const [id, device] of knownDevices) {
      if ((device.label ?? device.name) === deviceSourceId) {
        targetDeviceId = id;
        break;
      }
    }

    if (!targetDeviceId) {
      throw new Error(`Device "${deviceSourceId}" not found`);
    }

    const commands: Array<{ component: string; capability: string; command: string; arguments?: unknown[] }> = [];

    switch (key) {
      case "power":
        commands.push({
          component: "main",
          capability: "switch",
          command: value ? "on" : "off",
        });
        break;
      case "volume":
        commands.push({
          component: "main",
          capability: "audioVolume",
          command: "setVolume",
          arguments: [Number(value)],
        });
        break;
      case "mute":
        commands.push({
          component: "main",
          capability: "audioMute",
          command: value ? "mute" : "unmute",
        });
        break;
      case "input_source":
        commands.push({
          component: "main",
          capability: "samsungvd.mediaInputSource",
          command: "setInputSource",
          arguments: [String(value)],
        });
        break;
      default:
        throw new Error(`Unknown order key: ${key}`);
    }

    await apiPost(`/devices/${targetDeviceId}/commands`, { commands });
    logger.info({ deviceSourceId, key, value }, "SmartThings order executed");
  }

  // ── Plugin interface ─────────────────────────────────────

  return {
    id: INTEGRATION_ID,
    name: "Samsung SmartThings",
    description: "Samsung SmartThings devices (TV, washing machine, and more)",
    icon: "Smartphone",

    getSettings: () => SETTINGS,

    getStatus: () => status,

    isConfigured: () => !!getSetting("token"),

    start: async () => {
      logger.info({}, "SmartThings plugin starting");

      // Parse polling interval
      const intervalSetting = getSetting("polling_interval");
      if (intervalSetting) {
        const parsed = parseInt(intervalSetting, 10);
        if (!isNaN(parsed) && parsed >= 60) {
          pollIntervalMs = parsed * 1000;
        }
      }
      if (pollIntervalMs < MIN_POLL_INTERVAL) {
        pollIntervalMs = MIN_POLL_INTERVAL;
      }

      // Initial poll
      await poll();

      // Schedule periodic polls
      pollTimer = setInterval(() => {
        poll().catch((err) => {
          logger.error(
            { err: err instanceof Error ? { message: err.message } : {} },
            "SmartThings poll error",
          );
        });
      }, pollIntervalMs);

      logger.info({ intervalMs: pollIntervalMs, devices: knownDevices.size }, "SmartThings plugin started");
    },

    stop: async () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      status = "disconnected";
      logger.info({}, "SmartThings plugin stopped");
    },

    executeOrder,

    getPollingInfo: () =>
      lastPollAt
        ? { lastPollAt, intervalMs: pollIntervalMs }
        : null,
  };
}
