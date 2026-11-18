/**
 * @file vitest/ledDevice.test.ts
 * @description Tests for the LED device: push updates, fade handling, request serialization, retries and reachability.
 * @author Roman Schlich
 */

import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';

import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { BridgedDeviceBasicInformation, ColorControl, LevelControl, OnOff } from 'matterbridge/matter/clusters';

import type { LedControllerClient } from '../src/ledClient.js';
import { type LedDeviceSettings, RgbwwLedDevice } from '../src/ledDevice.js';
import type { HsvColor } from '../src/mapping.js';

const loggerLogSpy = vi.spyOn(AnsiLogger.prototype, 'log').mockImplementation(() => {});

const RED: HsvColor = { h: 0, s: 100, v: 100, ct: 2700 };

/**
 * Build a firmware color_event message.
 *
 * @param {HsvColor} hsv Color.
 * @returns {string} The JSON-RPC message.
 */
function colorEvent(hsv: HsvColor): string {
  return JSON.stringify({ jsonrpc: '2.0', method: 'color_event', params: { mode: 'hsv', hsv }, id: 1 });
}

/**
 * Wait for a number of milliseconds.
 *
 * @param {number} ms Delay.
 * @returns {Promise<void>} Resolves after the delay.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('RgbwwLedDevice', () => {
  let server: Server;
  let port: number;
  let sockets: Socket[];
  let device: RgbwwLedDevice | undefined;
  let client: {
    host: string;
    getColor: ReturnType<typeof vi.fn<() => Promise<HsvColor>>>;
    setColor: ReturnType<typeof vi.fn<(color: HsvColor, transitionMs: number) => Promise<void>>>;
  };

  /**
   * Create a device with mocked endpoint attribute methods.
   *
   * @param {Partial<LedDeviceSettings>} settings Settings overrides.
   * @returns {RgbwwLedDevice} The device.
   */
  function createDevice(settings: Partial<LedDeviceSettings> = {}): RgbwwLedDevice {
    const created = new RgbwwLedDevice(
      { name: 'Test', serialNumber: 'SN1', vendorId: 0xfff1, transitionMs: 200, pollIntervalMs: 60_000, useEventServer: true, eventPort: port, ...settings },
      client as unknown as LedControllerClient,
    );
    vi.spyOn(created.endpoint, 'updateAttribute').mockResolvedValue(true);
    vi.spyOn(created.endpoint, 'getAttribute').mockReturnValue(0);
    vi.spyOn(created.endpoint, 'hasAttributeServer').mockReturnValue(true);
    return created;
  }

  /**
   * Count how often a remote color was applied to the attributes.
   *
   * @param {RgbwwLedDevice} target The device.
   * @returns {number} Number of applies.
   */
  function countApplies(target: RgbwwLedDevice): number {
    return vi.mocked(target.endpoint.updateAttribute).mock.calls.filter(([, attribute]) => attribute === 'colorMode').length;
  }

  /**
   * Execute a command handler on the device.
   *
   * @param {string} command Command name.
   * @param {object} request Command request.
   * @param {string} cluster Cluster name.
   */
  async function executeCommand(command: string, request: object, cluster: string): Promise<void> {
    if (!device) throw new Error('Device not created');
    const { endpoint } = device;
    await endpoint.executeCommandHandler(command as any, request as any, cluster as any, {} as any, endpoint);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    client = { host: '127.0.0.1', getColor: vi.fn(async () => RED), setColor: vi.fn(async () => {}) };
    sockets = [];
    server = createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    device?.stop();
    device = undefined;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('should update the attributes when the controller pushes a color', async () => {
    device = createDevice();
    const { endpoint } = device;
    device.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].write(colorEvent({ h: 161.58, s: 62.37, v: 100, ct: 2746 }));
    await vi.waitFor(() => expect(endpoint.updateAttribute).toHaveBeenCalledWith(ColorControl.id, 'currentHue', 114, endpoint.log));
    expect(endpoint.updateAttribute).toHaveBeenCalledWith(OnOff.id, 'onOff', true, endpoint.log);
    expect(endpoint.updateAttribute).toHaveBeenCalledWith(LevelControl.id, 'currentLevel', 254, endpoint.log);
    expect(endpoint.updateAttribute).toHaveBeenCalledWith(ColorControl.id, 'currentSaturation', 158, endpoint.log);
    // In hue/saturation mode the color temperature of the firmware says nothing about the shown color.
    expect(endpoint.updateAttribute).not.toHaveBeenCalledWith(ColorControl.id, 'colorTemperatureMireds', expect.anything(), endpoint.log);
    expect(endpoint.updateAttribute).toHaveBeenCalledWith(ColorControl.id, 'colorMode', ColorControl.ColorMode.CurrentHueAndCurrentSaturation, endpoint.log);
    expect(endpoint.updateAttribute).toHaveBeenCalledWith(ColorControl.id, 'enhancedColorMode', ColorControl.ColorMode.CurrentHueAndCurrentSaturation, endpoint.log);
    expect(loggerLogSpy).toHaveBeenCalledWith(LogLevel.INFO, 'Connected to event server, using push updates');
    expect(device.currentColor).toEqual({ h: 161.58, s: 62.37, v: 100, ct: 2746 });
  });

  test('should use color temperature mode and keep the level when a white color is reported before any command', async () => {
    client.getColor.mockResolvedValue({ h: 0, s: 0, v: 0, ct: 6135 });
    const created = createDevice();
    device = created;
    const { endpoint } = created;
    device.start();
    await vi.waitFor(() => expect(endpoint.updateAttribute).toHaveBeenCalledWith(ColorControl.id, 'colorMode', ColorControl.ColorMode.ColorTemperatureMireds, endpoint.log));
    expect(endpoint.updateAttribute).toHaveBeenCalledWith(ColorControl.id, 'colorTemperatureMireds', 163, endpoint.log);
    expect(endpoint.updateAttribute).toHaveBeenCalledWith(OnOff.id, 'onOff', false, endpoint.log);
    expect(endpoint.updateAttribute).not.toHaveBeenCalledWith(LevelControl.id, 'currentLevel', expect.anything(), endpoint.log);
  });

  test('should keep hue and saturation mode when a command drags the saturation to zero', async () => {
    const created = createDevice();
    device = created;
    const { endpoint } = created;
    device.start();
    await vi.waitFor(() => expect(countApplies(created)).toBe(1));
    await vi.waitFor(() => expect(loggerLogSpy).toHaveBeenCalledWith(LogLevel.INFO, 'Connected to event server, using push updates'));
    vi.mocked(endpoint.updateAttribute).mockClear();

    // The white center of the color wheel is still a hue/saturation selection, not a color temperature one.
    client.getColor.mockResolvedValue({ h: 92.14, s: 0, v: 100, ct: 2700 });
    await executeCommand('moveToHueAndSaturation', { hue: 65, saturation: 0, transitionTime: 0 }, 'colorControl');
    await vi.waitFor(() => expect(countApplies(created)).toBe(1), { timeout: 5000 });
    expect(endpoint.updateAttribute).toHaveBeenCalledWith(ColorControl.id, 'colorMode', ColorControl.ColorMode.CurrentHueAndCurrentSaturation, endpoint.log);
    expect(endpoint.updateAttribute).not.toHaveBeenCalledWith(ColorControl.id, 'colorMode', ColorControl.ColorMode.ColorTemperatureMireds, endpoint.log);

    // A color temperature command switches the mode, and a later white color keeps it.
    await executeCommand('moveToColorTemperature', { colorTemperatureMireds: 370, transitionTime: 0 }, 'colorControl');
    await vi.waitFor(() => expect(countApplies(created)).toBe(2), { timeout: 5000 });
    expect(endpoint.updateAttribute).toHaveBeenCalledWith(ColorControl.id, 'colorMode', ColorControl.ColorMode.ColorTemperatureMireds, endpoint.log);
  });

  test('should drop pushed colors while an own fade is running and poll the settled color afterwards', async () => {
    const created = createDevice();
    device = created;
    const { endpoint } = created;
    device.start();
    await vi.waitFor(() => expect(countApplies(created)).toBe(1));
    await vi.waitFor(() => expect(loggerLogSpy).toHaveBeenCalledWith(LogLevel.INFO, 'Connected to event server, using push updates'));

    client.getColor.mockResolvedValue({ h: 0, s: 100, v: 0, ct: 2700 });
    await executeCommand('off', {}, 'onOff');
    await vi.waitFor(() => expect(client.setColor).toHaveBeenCalledWith({ h: 0, s: 100, v: 0, ct: 2700 }, 200));
    // The firmware reports intermediate fade values, they must never reach the attributes.
    sockets[0].write(colorEvent({ h: 0, s: 100, v: 40, ct: 2700 }));
    await vi.waitFor(() => expect(loggerLogSpy).toHaveBeenCalledWith(LogLevel.DEBUG, 'Ignoring color during fade h:0 s:100 v:40 ct:2700'));

    await vi.waitFor(() => expect(countApplies(created)).toBe(2), { timeout: 5000 });
    expect(created.currentColor.v).toBe(0);
    expect(endpoint.updateAttribute).not.toHaveBeenCalledWith(LevelControl.id, 'currentLevel', 102, endpoint.log);
    expect(client.getColor).toHaveBeenCalledTimes(2);
  });

  test('should keep the full saturation of a command when the fade reports a less saturated color last', async () => {
    const created = createDevice();
    device = created;
    const { endpoint } = created;
    device.start();
    await vi.waitFor(() => expect(countApplies(created)).toBe(1));
    await vi.waitFor(() => expect(loggerLogSpy).toHaveBeenCalledWith(LogLevel.INFO, 'Connected to event server, using push updates'));
    vi.mocked(endpoint.updateAttribute).mockClear();

    // A slow settling poll leaves the intermediate fade value enough time to be applied first.
    client.getColor.mockImplementation(async () => {
      await sleep(400);
      return { h: 0, s: 100, v: 100, ct: 2700 };
    });
    await executeCommand('moveToHueAndSaturation', { hue: 0, saturation: 254, transitionTime: 0 }, 'colorControl');
    await vi.waitFor(() => expect(client.setColor).toHaveBeenCalledWith({ h: 0, s: 100, v: 100, ct: 2700 }, 200));
    // Last event of the fade, still on the way to full saturation.
    sockets[0].write(colorEvent({ h: 0, s: 71.5, v: 100, ct: 2700 }));

    await vi.waitFor(() => expect(endpoint.updateAttribute).toHaveBeenCalledWith(ColorControl.id, 'currentSaturation', 254, endpoint.log), { timeout: 5000 });
    expect(endpoint.updateAttribute).not.toHaveBeenCalledWith(ColorControl.id, 'currentSaturation', 182, endpoint.log);
    expect(created.currentColor.s).toBe(100);
  });

  test('should discard a pushed color when a command is sent before the debounce elapsed', async () => {
    const created = createDevice();
    device = created;
    const { endpoint } = created;
    device.start();
    await vi.waitFor(() => expect(countApplies(created)).toBe(1));
    await vi.waitFor(() => expect(loggerLogSpy).toHaveBeenCalledWith(LogLevel.INFO, 'Connected to event server, using push updates'));
    vi.mocked(endpoint.updateAttribute).mockClear();

    sockets[0].write(colorEvent({ h: 120, s: 50, v: 80, ct: 2700 }));
    await vi.waitFor(() => expect(loggerLogSpy).toHaveBeenCalledWith(LogLevel.DEBUG, 'Push update h:120 s:50 v:80 ct:2700'));
    await executeCommand('off', {}, 'onOff');
    await sleep(500);
    expect(endpoint.updateAttribute).not.toHaveBeenCalledWith(ColorControl.id, 'currentHue', 85, endpoint.log);
    expect(created.currentColor.h).toBe(0);
  });

  test('should send one request at a time and coalesce commands to the latest color', async () => {
    let active = 0;
    let maxActive = 0;
    client.setColor.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(500);
      active--;
    });
    device = createDevice({ useEventServer: false });
    await executeCommand('moveToHueAndSaturation', { hue: 0, saturation: 254, transitionTime: 0 }, 'colorControl');
    await sleep(150);
    await executeCommand('moveToHueAndSaturation', { hue: 127, saturation: 254, transitionTime: 0 }, 'colorControl');
    await sleep(150);
    await executeCommand('moveToHueAndSaturation', { hue: 254, saturation: 254, transitionTime: 0 }, 'colorControl');
    await vi.waitFor(() => expect(client.setColor).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await sleep(600);
    expect(client.setColor).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    expect(client.setColor).toHaveBeenLastCalledWith({ h: 360, s: 100, v: 0, ct: 2700 }, 200);
  });

  test('should retry a failed send and stay reachable when a retry succeeds', async () => {
    client.setColor.mockRejectedValueOnce(new Error('socket hang up'));
    device = createDevice({ useEventServer: false, sendRetryMs: 50 });
    await executeCommand('on', {}, 'onOff');
    await vi.waitFor(() => expect(client.setColor).toHaveBeenCalledTimes(2));
    expect(loggerLogSpy).toHaveBeenCalledWith(LogLevel.WARN, 'Set color failed, retrying: socket hang up');
    expect(loggerLogSpy).toHaveBeenCalledWith(LogLevel.INFO, 'Setting color h:0 s:0 v:100 ct:2700 t:200 (attempt 2/3)');
    expect(device.endpoint.updateAttribute).not.toHaveBeenCalledWith(BridgedDeviceBasicInformation.id, 'reachable', false, device.endpoint.log);
  });

  test('should report unreachable after repeated failures and recover by polling', async () => {
    client.setColor.mockRejectedValue(new Error('ECONNREFUSED'));
    client.getColor.mockRejectedValue(new Error('offline'));
    const created = createDevice({ useEventServer: false, transitionMs: 0, sendRetryMs: 50, recoveryPollMs: 100 });
    device = created;
    const { endpoint } = created;
    await executeCommand('on', {}, 'onOff');
    await vi.waitFor(() => expect(loggerLogSpy).toHaveBeenCalledWith(LogLevel.ERROR, 'Set color failed after 3 attempts: ECONNREFUSED'));
    expect(endpoint.updateAttribute).toHaveBeenCalledWith(BridgedDeviceBasicInformation.id, 'reachable', false, endpoint.log);
    expect(loggerLogSpy).toHaveBeenCalledWith(LogLevel.WARN, 'Controller not reachable, retrying every 0 s');

    client.getColor.mockResolvedValue(RED);
    await vi.waitFor(() => expect(loggerLogSpy).toHaveBeenCalledWith(LogLevel.INFO, 'Controller reachable again'));
    expect(endpoint.updateAttribute).toHaveBeenCalledWith(BridgedDeviceBasicInformation.id, 'reachable', true, endpoint.log);
    const pollsAfterRecovery = client.getColor.mock.calls.length;
    await sleep(300);
    expect(client.getColor).toHaveBeenCalledTimes(pollsAfterRecovery);
  });

  test('should log a failed poll only once while failing', async () => {
    client.getColor.mockRejectedValue(new Error('offline'));
    device = createDevice({ useEventServer: false, recoveryPollMs: 50 });
    device.start();
    await vi.waitFor(() => expect(client.getColor.mock.calls.length).toBeGreaterThanOrEqual(4));
    expect(loggerLogSpy.mock.calls.filter(([level, message]) => level === LogLevel.WARN && message.startsWith('Status poll failed'))).toHaveLength(1);
  });

  test('should skip the reachable attribute when the endpoint has no bridged basic information', async () => {
    client.getColor.mockRejectedValue(new Error('offline'));
    const created = createDevice({ useEventServer: false, recoveryPollMs: 20 });
    device = created;
    vi.mocked(created.endpoint.hasAttributeServer).mockReturnValue(false);
    device.start();
    await vi.waitFor(() => expect(loggerLogSpy).toHaveBeenCalledWith(LogLevel.WARN, expect.stringContaining('Controller not reachable')));
    expect(created.endpoint.updateAttribute).not.toHaveBeenCalled();
  });

  test('should log once when the event server is not available', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    device = createDevice();
    device.start();
    await vi.waitFor(() =>
      expect(loggerLogSpy).toHaveBeenCalledWith(LogLevel.INFO, expect.stringMatching(/^Event server not available \(.*ECONNREFUSED.*\), using polling every 60 s$/)),
    );
    expect(loggerLogSpy.mock.calls.filter(([, message]) => message.startsWith('Event server not available'))).toHaveLength(1);
    device.stop();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  });
});
