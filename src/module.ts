/**
 * @file src/module.ts
 * @description Matterbridge plugin for ESP RGBWW LED controllers.
 * @author Roman Schlich
 * @created 2026-09-15
 * @version 1.0.0
 * @license Apache-2.0
 *
 * Based on the Matterbridge plugin template by Luca Liguori (Apache-2.0).
 */

import { type BasePlatformConfig, MatterbridgeDynamicPlatform, type PlatformMatterbridge } from 'matterbridge';
import type { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { LedControllerClient } from './ledClient.js';
import { RgbwwLedDevice } from './ledDevice.js';
import { isRecord } from './mapping.js';

/** One configured LED controller. */
export interface LedControllerConfig {
  /** Device name. */
  name: string;
  /** Host name or IP address. */
  hostName: string;
}

// This allows to have type checking and autocompletion for the instance config.
export type RgbwwPlatformConfig = BasePlatformConfig & {
  whiteList: string[];
  blackList: string[];
  devices?: LedControllerConfig[];
  pollIntervalSeconds?: number;
  transitionMs?: number;
  useEventServer?: boolean;
};

export const DEFAULT_POLL_INTERVAL_SECONDS = 300;
export const DEFAULT_TRANSITION_MS = 600;
const MIN_POLL_INTERVAL_SECONDS = 10;
const MAX_SERIAL_NUMBER_LENGTH = 32;

/**
 * This is the standard interface for Matterbridge plugins.
 *
 * @param {PlatformMatterbridge} matterbridge - An instance of MatterBridge.
 * @param {AnsiLogger} log - An instance of AnsiLogger.
 * @param {RgbwwPlatformConfig} config - The platform configuration.
 * @returns {RgbwwPlatform} - The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: RgbwwPlatformConfig): RgbwwPlatform {
  return new RgbwwPlatform(matterbridge, log, config);
}

/**
 * Extract the valid, unique LED controller entries from the config.
 *
 * Edge cases:
 *  - entries without a non-empty name or hostName are skipped
 *  - duplicate host names are skipped
 *
 * @param {unknown} devices The `devices` config value.
 * @param {AnsiLogger} log Logger for skipped entries.
 * @returns {LedControllerConfig[]} Valid entries with trimmed values.
 */
export function getControllerConfigs(devices: unknown, log: AnsiLogger): LedControllerConfig[] {
  if (!Array.isArray(devices)) return [];
  const result: LedControllerConfig[] = [];
  const hosts = new Set<string>();
  for (const entry of devices) {
    const name = isRecord(entry) && typeof entry.name === 'string' ? entry.name.trim() : '';
    const hostName = isRecord(entry) && typeof entry.hostName === 'string' ? entry.hostName.trim() : '';
    if (name === '' || hostName === '') {
      log.warn(`Skipping invalid device config ${JSON.stringify(entry)}: name and hostName are required`);
      continue;
    }
    if (hosts.has(hostName)) {
      log.warn(`Skipping device ${name}: host ${hostName} is configured more than once`);
      continue;
    }
    hosts.add(hostName);
    result.push({ name, hostName });
  }
  return result;
}

/** Dynamic platform exposing every configured LED controller as extended color light. */
export class RgbwwPlatform extends MatterbridgeDynamicPlatform {
  private readonly ledDevices: RgbwwLedDevice[] = [];

  constructor(
    matterbridge: PlatformMatterbridge,
    log: AnsiLogger,
    override config: RgbwwPlatformConfig,
  ) {
    // Always call super(matterbridge, log, config)
    super(matterbridge, log, config);

    // Verify that Matterbridge is the correct version
    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.10.9')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.10.9". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`,
      );
    }

    this.log.info(`Initializing platform ${this.config.name}...`);
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`Starting platform ${this.config.name} with reason: ${reason ?? 'no reason provided'}...`);

    // Wait for the platform to fully load the select.
    await this.ready;
    await this.clearSelect();

    this.stopDevices();
    this.ledDevices.length = 0;

    const controllers = getControllerConfigs(this.config.devices, this.log);
    if (controllers.length === 0) this.log.warn('No LED controllers configured');

    for (const controller of controllers) {
      await this.registerController(controller);
    }

    this.log.info(`Platform ${this.config.name} started with ${this.ledDevices.length} device(s)`);
  }

  override async onConfigure(): Promise<void> {
    // Always call super.onConfigure()
    await super.onConfigure();

    this.log.info(`Configuring platform ${this.config.name}...`);
    for (const device of this.ledDevices) device.start();
    this.log.info(`Platform ${this.config.name} configured successfully`);
  }

  // oxlint-disable-next-line typescript/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
    for (const device of this.ledDevices) device.endpoint.log.logLevel = logLevel;
  }

  override async onShutdown(reason?: string): Promise<void> {
    // Always call super.onShutdown(reason)
    await super.onShutdown(reason);

    this.log.info(`Shutting down platform ${this.config.name} with reason: ${reason ?? 'no reason provided'}...`);

    this.stopDevices();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();

    this.log.info(`Platform ${this.config.name} shut down successfully`);
  }

  /**
   * Create and register the Matter device for one controller.
   *
   * @param {LedControllerConfig} controller Controller config.
   * @returns {Promise<void>} Resolves when the device is registered or skipped.
   */
  private async registerController(controller: LedControllerConfig): Promise<void> {
    const client = new LedControllerClient(controller.hostName);
    // The host name is the stable serial number: it is known even when the controller is offline at startup.
    const serialNumber = client.host.slice(0, MAX_SERIAL_NUMBER_LENGTH);

    this.setSelectDevice(serialNumber, controller.name);
    if (!this.validateDevice([controller.name, serialNumber])) return;

    let firmwareVersion: string | undefined;
    try {
      const info = await client.getInfo();
      firmwareVersion = info.firmwareVersion;
      this.log.info(`Found controller ${controller.name} at ${client.host} (id ${info.deviceId ?? '?'}, mac ${info.macAddress ?? '?'}, firmware ${firmwareVersion ?? '?'})`);
    } catch (error) {
      this.log.warn(`Controller ${controller.name} at ${client.host} not reachable at startup: ${error instanceof Error ? error.message : String(error)}`);
    }

    const pollIntervalSeconds = Math.max(this.config.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS, MIN_POLL_INTERVAL_SECONDS);
    const device = new RgbwwLedDevice(
      {
        name: controller.name,
        serialNumber,
        vendorId: this.matterbridge.aggregatorVendorId,
        firmwareVersion,
        transitionMs: Math.max(this.config.transitionMs ?? DEFAULT_TRANSITION_MS, 0),
        pollIntervalMs: pollIntervalSeconds * 1000,
        useEventServer: this.config.useEventServer ?? true,
        debug: this.config.debug,
      },
      client,
    );
    await this.registerDevice(device.endpoint);
    this.ledDevices.push(device);
  }

  /** Stop polling and event connections of all devices. */
  private stopDevices(): void {
    for (const device of this.ledDevices) device.stop();
  }
}
