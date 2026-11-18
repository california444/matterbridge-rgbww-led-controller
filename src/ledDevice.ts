/**
 * @file src/ledDevice.ts
 * @description Matter extended color light backed by one ESP RGBWW LED controller.
 * @author Roman Schlich
 * @created 2026-09-15
 * @version 1.0.5
 * @license Apache-2.0
 */

import { extendedColorLight, MatterbridgeEndpoint } from 'matterbridge';
import { BridgedDeviceBasicInformation, ColorControl, LevelControl, OnOff } from 'matterbridge/matter/clusters';

import { LedEventClient } from './eventClient.js';
import type { LedControllerClient } from './ledClient.js';
import {
  brightnessToLevel,
  DEFAULT_COLOR_TEMPERATURE_KELVIN,
  degreesToHue,
  type HsvColor,
  hueToDegrees,
  kelvinToMireds,
  levelToBrightness,
  MAX_COLOR_TEMPERATURE_MIREDS,
  MIN_COLOR_TEMPERATURE_MIREDS,
  MIN_LEVEL,
  miredsToKelvin,
  percentToSaturation,
  saturationToPercent,
} from './mapping.js';

/** Debounce for outgoing commands, controllers often send OnOff + Level + Color in quick succession. */
const SEND_DEBOUNCE_MS = 100;
/** Debounce for incoming state, the firmware sends several color_event messages during a fade. */
const REMOTE_DEBOUNCE_MS = 300;
/** Extra time after a fade before state from the controller is trusted again. */
const TRANSITION_GRACE_MS = 1000;
/** Attempts for sending one color before giving up. */
const MAX_SEND_ATTEMPTS = 3;
/** Consecutive failed requests before the device is reported unreachable. */
const UNREACHABLE_AFTER_FAILURES = 3;

/** Settings of one LED device. */
export interface LedDeviceSettings {
  /** Device name shown in the Matter controller. */
  name: string;
  /** Serial number (max 32 characters). */
  serialNumber: string;
  /** Vendor id of the bridge. */
  vendorId: number;
  /** Firmware version reported by `/info`. */
  firmwareVersion?: string;
  /** Fade duration in milliseconds. */
  transitionMs: number;
  /** Poll interval in milliseconds. */
  pollIntervalMs: number;
  /** Connect to the JSON-RPC event server. */
  useEventServer: boolean;
  /** Event server port, default 9090. */
  eventPort?: number;
  /** Delay between send attempts in milliseconds, default 1000. */
  sendRetryMs?: number;
  /** Poll interval after a failed request until the controller answers again, default 10000. */
  recoveryPollMs?: number;
  /** Enable endpoint debug logging. */
  debug?: boolean;
}

/**
 * Format an error for logging.
 *
 * @param {unknown} error The error.
 * @returns {string} The error message.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One LED controller exposed as Matter extended color light. */
export class RgbwwLedDevice {
  readonly endpoint: MatterbridgeEndpoint;
  private color: HsvColor = { h: 0, s: 0, v: 0, ct: DEFAULT_COLOR_TEMPERATURE_KELVIN };
  private colorMode: ColorControl.ColorMode = ColorControl.ColorMode.ColorTemperatureMireds;
  private lastBrightness = 100;
  private eventClient?: LedEventClient;
  private sendTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private recoveryTimer?: NodeJS.Timeout;
  private remoteTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private pendingRemoteColor?: HsvColor;
  private suppressRemoteUntil = 0;
  private isSending = false;
  private isSendQueued = false;
  private sendAttempt = 0;
  private consecutiveFailures = 0;
  private reachable = true;
  private eventServerUnavailableLogged = false;

  /**
   * Create the Matter endpoint and register the command handlers. Register {@link endpoint} with the platform, then call {@link start}.
   *
   * @param {LedDeviceSettings} settings Device settings.
   * @param {LedControllerClient} client HTTP client of the controller.
   */
  constructor(
    private readonly settings: LedDeviceSettings,
    private readonly client: LedControllerClient,
  ) {
    this.endpoint = new MatterbridgeEndpoint(extendedColorLight, { id: `rgbww-${client.host}` }, settings.debug)
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        settings.name,
        settings.serialNumber,
        settings.vendorId,
        'Selbstbau',
        'RGBWW Wifi Led Controller',
        1,
        settings.firmwareVersion ?? 'unknown',
      )
      .createDefaultOnOffClusterServer(false)
      .createDefaultLevelControlClusterServer(254)
      .createHsColorControlClusterServer(0, 0, kelvinToMireds(DEFAULT_COLOR_TEMPERATURE_KELVIN), MIN_COLOR_TEMPERATURE_MIREDS, MAX_COLOR_TEMPERATURE_MIREDS)
      .addRequiredClusters();
    this.registerCommandHandlers();
  }

  /** Start polling and the event server connection. */
  start(): void {
    void this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), this.settings.pollIntervalMs);
    if (!this.settings.useEventServer) return;
    this.eventClient = new LedEventClient(
      { host: this.client.host.split(':')[0], port: this.settings.eventPort },
      {
        onColor: (color: HsvColor): void => {
          this.endpoint.log.debug(`Push update h:${color.h} s:${color.s} v:${color.v} ct:${color.ct}`);
          this.onRemoteColor(color);
        },
        onConnectionChange: (connected: boolean, error?: string): void => this.onEventConnectionChange(connected, error),
      },
    );
    this.eventClient.start();
  }

  /** Stop all timers and connections. */
  stop(): void {
    clearInterval(this.pollTimer);
    clearTimeout(this.sendTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.refreshTimer);
    clearTimeout(this.recoveryTimer);
    clearTimeout(this.remoteTimer);
    this.eventClient?.stop();
    this.eventClient = undefined;
  }

  /**
   * Current color state as known by the plugin.
   *
   * @returns {HsvColor} A copy of the current color.
   */
  get currentColor(): HsvColor {
    return { ...this.color };
  }

  /** Map Matter commands to firmware colors. Handlers run before Matter updates its own attributes. */
  private registerCommandHandlers(): void {
    this.endpoint
      .addCommandHandler('identify', ({ request }) => this.endpoint.log.info(`Identify called with identifyTime ${request.identifyTime}`))
      .addCommandHandler('on', () => this.turnOn())
      .addCommandHandler('off', () => this.turnOff())
      .addCommandHandler('toggle', () => (this.color.v > 0 ? this.turnOff() : this.turnOn()))
      .addCommandHandler('moveToLevel', ({ request }) => this.setLevel(request.level, false))
      .addCommandHandler('moveToLevelWithOnOff', ({ request }) => this.setLevel(request.level, true))
      .addCommandHandler('moveToHue', ({ request }) => this.setHueSaturation(hueToDegrees(request.hue), this.color.s))
      .addCommandHandler('moveToSaturation', ({ request }) => this.setHueSaturation(this.color.h, saturationToPercent(request.saturation)))
      .addCommandHandler('moveToHueAndSaturation', ({ request }) => this.setHueSaturation(hueToDegrees(request.hue), saturationToPercent(request.saturation)))
      .addCommandHandler('moveToColorTemperature', ({ request }) => this.setColorTemperature(miredsToKelvin(request.colorTemperatureMireds)));
  }

  /** Switch on with the last known brightness. */
  private turnOn(): void {
    this.color.v = this.lastBrightness;
    this.scheduleSend();
  }

  /** Switch off and remember the brightness. */
  private turnOff(): void {
    if (this.color.v > 0) this.lastBrightness = this.color.v;
    this.color.v = 0;
    this.scheduleSend();
  }

  /**
   * Apply a Matter level.
   *
   * @param {number} level Matter level (1..254).
   * @param {boolean} withOnOff True for moveToLevelWithOnOff: turns on, or off at the minimum level.
   */
  private setLevel(level: number, withOnOff: boolean): void {
    if (withOnOff && level <= MIN_LEVEL) {
      this.turnOff();
      return;
    }
    this.lastBrightness = levelToBrightness(level);
    if (withOnOff || this.color.v > 0) this.color.v = this.lastBrightness;
    this.scheduleSend();
  }

  /**
   * Apply hue and saturation.
   *
   * @param {number} hue Hue in degrees.
   * @param {number} saturation Saturation in percent.
   */
  private setHueSaturation(hue: number, saturation: number): void {
    this.logClusterState('before hue/saturation command');
    this.color.h = hue;
    this.color.s = saturation;
    this.colorMode = ColorControl.ColorMode.CurrentHueAndCurrentSaturation;
    this.scheduleSend();
  }

  /**
   * Apply a color temperature. Saturation is set to 0 so the firmware uses the white channels.
   *
   * @param {number} kelvin Color temperature in Kelvin.
   */
  private setColorTemperature(kelvin: number): void {
    this.color.ct = kelvin;
    this.color.s = 0;
    this.colorMode = ColorControl.ColorMode.ColorTemperatureMireds;
    this.scheduleSend();
  }

  /** Mark controller state as untrusted until the fade of the next send is done. */
  private suppressRemoteColor(): void {
    this.suppressRemoteUntil = Math.max(this.suppressRemoteUntil, Date.now() + SEND_DEBOUNCE_MS + this.settings.transitionMs + TRANSITION_GRACE_MS);
    this.pendingRemoteColor = undefined;
  }

  /** Send the current color after a short debounce. A new command cancels pending retries of an older color. */
  private scheduleSend(): void {
    this.suppressRemoteColor();
    clearTimeout(this.sendTimer);
    clearTimeout(this.retryTimer);
    this.sendAttempt = 0;
    this.sendTimer = setTimeout(() => void this.sendColor(), SEND_DEBOUNCE_MS);
  }

  /**
   * Send the current color to the controller.
   *
   * Only one request runs at a time: commands arriving meanwhile are coalesced and the latest color is sent
   * when the running request is done. Failed sends are retried up to {@link MAX_SEND_ATTEMPTS} times.
   *
   * A successful send schedules a settling poll after the fade, also when the event server is connected: the
   * firmware reports intermediate fade values and its last `color_event` does not have to carry the target color.
   */
  private async sendColor(): Promise<void> {
    if (this.isSending) {
      this.isSendQueued = true;
      return;
    }
    this.isSending = true;
    this.sendAttempt++;
    this.suppressRemoteColor();
    const color = this.currentColor;
    const attempt = this.sendAttempt > 1 ? ` (attempt ${this.sendAttempt}/${MAX_SEND_ATTEMPTS})` : '';
    this.endpoint.log.info(`Setting color h:${color.h} s:${color.s} v:${color.v} ct:${color.ct} t:${this.settings.transitionMs}${attempt}`);
    let error: unknown;
    try {
      await this.client.setColor(color, this.settings.transitionMs);
    } catch (sendError) {
      error = sendError ?? new Error('unknown error');
    }
    this.isSending = false;

    if (this.isSendQueued) {
      this.isSendQueued = false;
      this.sendAttempt = 0;
      await (error === undefined ? this.onRequestSucceeded() : this.onRequestFailed());
      void this.sendColor();
      return;
    }
    if (error === undefined) {
      await this.onRequestSucceeded();
      this.scheduleSettlingPoll();
      return;
    }
    if (this.sendAttempt < MAX_SEND_ATTEMPTS) {
      this.endpoint.log.warn(`Set color failed, retrying: ${errorMessage(error)}`);
      this.retryTimer = setTimeout(() => void this.sendColor(), this.settings.sendRetryMs ?? 1000);
    } else {
      this.endpoint.log.error(`Set color failed after ${MAX_SEND_ATTEMPTS} attempts: ${errorMessage(error)}`);
    }
    await this.onRequestFailed();
  }

  /**
   * Poll the color once the own fade is done.
   *
   * Timers can fire a few milliseconds before a deadline computed with `Date.now()`: on Linux the event loop
   * clock has a coarse resolution. A poll that early would be dropped as a fade value, so the poll is scheduled
   * again until the deadline has really passed.
   */
  private scheduleSettlingPoll(): void {
    clearTimeout(this.refreshTimer);
    const remainingMs = this.suppressRemoteUntil - Date.now();
    if (remainingMs > 0) {
      this.refreshTimer = setTimeout(() => this.scheduleSettlingPoll(), remainingMs);
      return;
    }
    void this.refresh();
  }

  /** Poll the current color from the controller. Skipped while a command is being sent. */
  private async refresh(): Promise<void> {
    if (this.isSending) return;
    try {
      const color = await this.client.getColor();
      this.endpoint.log.debug(`Status poll h:${color.h} s:${color.s} v:${color.v} ct:${color.ct}`);
      await this.onRequestSucceeded();
      this.onRemoteColor(color);
    } catch (error) {
      if (this.consecutiveFailures === 0) this.endpoint.log.warn(`Status poll failed: ${errorMessage(error)}`);
      await this.onRequestFailed();
    }
  }

  /**
   * Reset the failure state after a successful request.
   *
   * @returns {Promise<void>} Resolves when the reachable attribute is updated.
   */
  private async onRequestSucceeded(): Promise<void> {
    this.consecutiveFailures = 0;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    await this.setReachable(true);
  }

  /**
   * Count a failed request, report the device unreachable after repeated failures and poll until it answers again.
   *
   * @returns {Promise<void>} Resolves when the reachable attribute is updated.
   */
  private async onRequestFailed(): Promise<void> {
    this.consecutiveFailures++;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(() => void this.refresh(), this.settings.recoveryPollMs ?? 10_000);
    if (this.consecutiveFailures >= UNREACHABLE_AFTER_FAILURES) await this.setReachable(false);
  }

  /**
   * Handle a color reported by the controller (poll or push), debounced.
   *
   * Colors reported while an own fade is running are dropped instead of deferred: they carry intermediate fade
   * values and applying the last one would move the controller UI back to a color the light never settled on.
   * The settling poll of {@link sendColor} reports the real state once the fade is done.
   *
   * @param {HsvColor} color Reported color.
   */
  private onRemoteColor(color: HsvColor): void {
    if (Date.now() < this.suppressRemoteUntil) {
      this.endpoint.log.debug(`Ignoring color during fade h:${color.h} s:${color.s} v:${color.v} ct:${color.ct}`);
      return;
    }
    this.pendingRemoteColor = color;
    clearTimeout(this.remoteTimer);
    this.remoteTimer = setTimeout(() => {
      const pending = this.pendingRemoteColor;
      this.pendingRemoteColor = undefined;
      // A command sent meanwhile cleared the pending color, it is stale by then.
      if (pending) void this.applyRemoteColor(pending);
    }, REMOTE_DEBOUNCE_MS);
  }

  /**
   * Store a color reported by the controller and update the Matter attributes that changed.
   *
   * The firmware reports no color mode. Any saturation is hue/saturation, at saturation 0 the mode of the last
   * command is kept: dragging to the white center of a color wheel must not move the controller UI to its color
   * temperature picker. Only a color temperature command, or a white color reported before any command, selects it.
   *
   * @param {HsvColor} color Reported color.
   * @returns {Promise<void>} Resolves when the attributes are updated.
   */
  private async applyRemoteColor(color: HsvColor): Promise<void> {
    this.color = { ...color };
    if (color.v > 0) this.lastBrightness = color.v;
    if (color.s > 0) this.colorMode = ColorControl.ColorMode.CurrentHueAndCurrentSaturation;
    const { endpoint } = this;
    const colorMode = this.colorMode;
    endpoint.log.debug(
      `Applying color h:${color.h} s:${color.s} v:${color.v} ct:${color.ct} as hue:${degreesToHue(color.h)} saturation:${percentToSaturation(color.s)} mode:${colorMode}`,
    );
    await endpoint.updateAttribute(OnOff.id, 'onOff', color.v > 0, endpoint.log);
    if (color.v > 0) await endpoint.updateAttribute(LevelControl.id, 'currentLevel', brightnessToLevel(color.v), endpoint.log);
    await endpoint.updateAttribute(ColorControl.id, 'currentHue', degreesToHue(color.h), endpoint.log);
    await endpoint.updateAttribute(ColorControl.id, 'currentSaturation', percentToSaturation(color.s), endpoint.log);
    // Only meaningful in color temperature mode: the firmware keeps the last ct and reports it with every color,
    // so writing it in hue/saturation mode would pin the attribute to a temperature the light is not showing.
    if (colorMode === ColorControl.ColorMode.ColorTemperatureMireds) {
      await endpoint.updateAttribute(ColorControl.id, 'colorTemperatureMireds', kelvinToMireds(color.ct), endpoint.log);
    }
    await endpoint.updateAttribute(ColorControl.id, 'colorMode', colorMode, endpoint.log);
    await endpoint.updateAttribute(ColorControl.id, 'enhancedColorMode', colorMode, endpoint.log);
    this.logClusterState('after applying');
  }

  /**
   * Log the color attributes as they are stored in the clusters, not as the plugin believes them to be.
   *
   * Diagnostic only: it shows what a Matter controller reads back between commands, so a controller UI that
   * jumps to another color can be told apart from attributes that really carry the wrong value.
   *
   * @param {string} context Where the values were read.
   */
  private logClusterState(context: string): void {
    const { endpoint } = this;
    const hue = String(endpoint.getAttribute(ColorControl.id, 'currentHue'));
    const saturation = String(endpoint.getAttribute(ColorControl.id, 'currentSaturation'));
    const mireds = String(endpoint.getAttribute(ColorControl.id, 'colorTemperatureMireds'));
    const mode = String(endpoint.getAttribute(ColorControl.id, 'colorMode'));
    const level = String(endpoint.getAttribute(LevelControl.id, 'currentLevel'));
    const onOff = String(endpoint.getAttribute(OnOff.id, 'onOff'));
    endpoint.log.debug(`Cluster state ${context}: hue:${hue} saturation:${saturation} mireds:${mireds} mode:${mode} level:${level} onOff:${onOff}`);
  }

  /**
   * Update the reachable attribute when it changed.
   *
   * @param {boolean} reachable New reachability.
   * @returns {Promise<void>} Resolves when the attribute is updated.
   */
  private async setReachable(reachable: boolean): Promise<void> {
    if (this.reachable === reachable) return;
    this.reachable = reachable;
    if (reachable) this.endpoint.log.info('Controller reachable again');
    else this.endpoint.log.warn(`Controller not reachable, retrying every ${Math.round((this.settings.recoveryPollMs ?? 10_000) / 1000)} s`);
    if (this.endpoint.hasAttributeServer(BridgedDeviceBasicInformation.id, 'reachable')) {
      await this.endpoint.updateAttribute(BridgedDeviceBasicInformation.id, 'reachable', reachable, this.endpoint.log);
    }
  }

  /**
   * Log event server connection changes without flooding the log during reconnect attempts.
   *
   * @param {boolean} connected Connection state.
   * @param {string} [error] Last connection error.
   */
  private onEventConnectionChange(connected: boolean, error?: string): void {
    if (connected) {
      this.eventServerUnavailableLogged = false;
      this.endpoint.log.info('Connected to event server, using push updates');
      return;
    }
    if (this.eventServerUnavailableLogged) return;
    this.eventServerUnavailableLogged = true;
    this.endpoint.log.info(`Event server not available${error ? ` (${error})` : ''}, using polling every ${Math.round(this.settings.pollIntervalMs / 1000)} s`);
  }
}
