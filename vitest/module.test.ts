/**
 * @file vitest/module.test.ts
 * @description Tests for the RGBWW platform and device against a local fake LED controller.
 * @author Roman Schlich
 */

/**
 * WARNING!!!
 * The tests in this unit are supposed to run sequentially because they depend on the Matterbridge/Matter state.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import type { MatterbridgeEndpoint, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { VendorId } from 'matterbridge/matter';

import { getControllerConfigs, RgbwwPlatform, type RgbwwPlatformConfig } from '../src/module.js';

const mockMatterbridge = {
  systemInformation: {
    interfaceName: 'eth0',
    macAddress: 'aa:bb:cc:dd:ee:ff',
    ipv4Address: '192.168.1.1',
    ipv6Address: 'fd78:cbf8:4939:746:a96:8277:346f:416e',
    osRelease: 'x.y.z',
    nodeVersion: '22.10.0',
    hostname: 'matterbridge',
    user: 'vitest',
    osType: 'Linux',
    osPlatform: 'linux',
    osArch: 'x64',
    totalMemory: '0 B',
    freeMemory: '0 B',
    systemUptime: '0s',
    processUptime: '0s',
    cpuUsage: '0%',
    processCpuUsage: '0%',
    rss: '0 B',
    heapTotal: '0 B',
    heapUsed: '0 B',
  },
  uuid: '00000000-0000-0000-0000-000000000000',
  rootDirectory: path.join('.cache', 'vitest', 'RgbwwPlugin'),
  homeDirectory: path.join('.cache', 'vitest', 'RgbwwPlugin'),
  matterbridgeDirectory: path.join('.cache', 'vitest', 'RgbwwPlugin', '.matterbridge'),
  matterbridgePluginDirectory: path.join('.cache', 'vitest', 'RgbwwPlugin', 'Matterbridge'),
  matterbridgeCertDirectory: path.join('.cache', 'vitest', 'RgbwwPlugin', '.mattercert'),
  globalModulesDirectory: path.join('.cache', 'vitest', 'RgbwwPlugin', 'node_modules'),
  matterbridgeVersion: '3.10.9',
  matterbridgeLatestVersion: '3.10.9',
  matterbridgeDevVersion: '3.10.9',
  frontendVersion: '3.0.0',
  bridgeMode: 'bridge',
  restartMode: 'docker',
  virtualMode: 'mounted_switch',
  aggregatorVendorId: VendorId(0xfff1),
  aggregatorVendorName: 'Matterbridge',
  aggregatorProductId: 0x8000,
  aggregatorProductName: 'Matterbridge Vitest Aggregator',
} as unknown as PlatformMatterbridge;

const mockLog = {
  fatal: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  notice: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as AnsiLogger;

// Mocked methods
const addBridgedEndpoint = vi.fn(async (pluginName: string, device: MatterbridgeEndpoint) => {});
const removeBridgedEndpoint = vi.fn(async (pluginName: string, device: MatterbridgeEndpoint) => {});
const removeAllBridgedEndpoints = vi.fn(async (pluginName: string) => {});
const registerVirtualDevice = vi.fn(async (name: string, type: string, callback: () => Promise<void>) => {});

// Mock the logger
const loggerLogSpy = vi.spyOn(AnsiLogger.prototype, 'log').mockImplementation(() => {});

/** Fake LED controller state. */
const controller = {
  hsv: { h: 0, s: 0, v: 50, ct: 6135 },
  posts: [] as { hsv: { h: number; s: number; v: number; ct: number }; cmd: string; t: number }[],
  getColorCount: 0,
};

describe('Matterbridge RGBWW LED Controller', () => {
  let server: Server;
  let host: string;
  let instance: RgbwwPlatform;
  let mockConfig: RgbwwPlatformConfig;

  /**
   * Execute a command handler on the first device.
   *
   * @param {string} command Command name.
   * @param {object} request Command request.
   * @param {string} cluster Cluster name.
   */
  async function executeCommand(command: string, request: object, cluster: string): Promise<void> {
    const device = instance.getDevices()[0];
    await device.executeCommandHandler(command as any, request as any, cluster as any, {} as any, device);
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        if (request.url === '/info') {
          response.end('{"deviceid":"12345678","git_version":"vbs35","connection":{"mac":"aabbccddeeff"}}');
        } else if (request.method === 'POST') {
          const post = JSON.parse(body);
          controller.posts.push(post);
          controller.hsv = post.hsv;
          response.end('{"success":true}');
        } else {
          controller.getColorCount++;
          response.end(JSON.stringify({ raw: {}, hsv: controller.hsv }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    mockConfig = {
      name: 'matterbridge-rgbww-led-controller',
      type: 'DynamicPlatform',
      version: '1.0.0',
      devices: [
        { name: 'LED Strip', hostName: `http://${host}/` },
        { name: 'Duplicate', hostName: `http://${host}/` },
        { name: 'Offline', hostName: '127.0.0.1:1' },
      ],
      transitionMs: 0,
      useEventServer: false,
      pollIntervalSeconds: 10,
      whiteList: ['LED Strip'],
      blackList: [],
      debug: false,
      unregisterOnShutdown: false,
    };
  });

  beforeEach(() => {
    vi.clearAllMocks();
    controller.posts = [];
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
  });

  test('should skip invalid and duplicate device configs', () => {
    expect(getControllerConfigs(undefined, mockLog)).toEqual([]);
    expect(getControllerConfigs([{ name: ' A ', hostName: ' 1.2.3.4 ' }, { name: 'B', hostName: '1.2.3.4' }, { name: '', hostName: 'x' }, 'x'], mockLog)).toEqual([
      { name: 'A', hostName: '1.2.3.4' },
    ]);
    expect(mockLog.warn).toHaveBeenCalledTimes(3);
  });

  test('should throw an error when matterbridge is not the required version', () => {
    expect(() => new RgbwwPlatform({ ...mockMatterbridge, matterbridgeVersion: '2.0.0' }, mockLog, mockConfig)).toThrow(
      'This plugin requires Matterbridge version >= "3.10.9". Please update Matterbridge from 2.0.0 to the latest version in the frontend.',
    );
  });

  test('should create an instance of the platform', async () => {
    instance = (await import('../src/module.js')).default(mockMatterbridge, mockLog, mockConfig);
    expect(instance).toBeInstanceOf(RgbwwPlatform);
    // @ts-expect-error Accessing private method for testing purposes
    instance.setMatterNode(addBridgedEndpoint, removeBridgedEndpoint, removeAllBridgedEndpoints, registerVirtualDevice);
    expect(mockLog.info).toHaveBeenCalledWith('Initializing platform matterbridge-rgbww-led-controller...');
  });

  test('should warn when no devices are configured', async () => {
    const empty = new RgbwwPlatform(mockMatterbridge, mockLog, { ...mockConfig, devices: undefined });
    // @ts-expect-error Accessing private method for testing purposes
    empty.setMatterNode(addBridgedEndpoint, removeBridgedEndpoint, removeAllBridgedEndpoints, registerVirtualDevice);
    await empty.onStart();
    expect(mockLog.warn).toHaveBeenCalledWith('No LED controllers configured');
    expect(addBridgedEndpoint).not.toHaveBeenCalled();
  });

  test('should register the white listed device when starting', async () => {
    await instance.onStart('Vitest');
    expect(mockLog.info).toHaveBeenCalledWith('Starting platform matterbridge-rgbww-led-controller with reason: Vitest...');
    expect(mockLog.info).toHaveBeenCalledWith(`Found controller LED Strip at ${host} (id 12345678, mac aabbccddeeff, firmware vbs35)`);
    expect(mockLog.warn).toHaveBeenCalledWith(`Skipping device Duplicate: host http://${host}/ is configured more than once`);
    expect(addBridgedEndpoint).toHaveBeenCalledTimes(1);
    expect(instance.getDevices()[0].serialNumber).toBe(host);
  });

  test('should register a device when the controller is offline at startup', async () => {
    const offline = new RgbwwPlatform(mockMatterbridge, mockLog, { ...mockConfig, whiteList: ['Offline'], devices: [{ name: 'Offline', hostName: '127.0.0.1:1' }] });
    // @ts-expect-error Accessing private method for testing purposes
    offline.setMatterNode(addBridgedEndpoint, removeBridgedEndpoint, removeAllBridgedEndpoints, registerVirtualDevice);
    await offline.onStart();
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Controller Offline at 127.0.0.1:1 not reachable at startup'));
    expect(addBridgedEndpoint).toHaveBeenCalledTimes(1);
  });

  test('should send a fade command when hue and saturation change', async () => {
    await executeCommand('moveToHueAndSaturation', { hue: 127, saturation: 254, transitionTime: 0 }, 'colorControl');
    await vi.waitFor(() => expect(controller.posts).toHaveLength(1));
    expect(controller.posts[0]).toEqual({ hsv: { h: 180, s: 100, v: 0, ct: 2700 }, cmd: 'fade', t: 0 });
  });

  test('should debounce commands sent in quick succession', async () => {
    await executeCommand('on', {}, 'onOff');
    await executeCommand('moveToLevelWithOnOff', { level: 127, transitionTime: 0 }, 'levelControl');
    await executeCommand('moveToHue', { hue: 254, direction: 0, transitionTime: 0 }, 'colorControl');
    await executeCommand('moveToSaturation', { saturation: 127, transitionTime: 0 }, 'colorControl');
    await vi.waitFor(() => expect(controller.posts).toHaveLength(1));
    expect(controller.posts[0].hsv).toEqual({ h: 360, s: 50, v: 50, ct: 2700 });
  });

  test('should restore the last brightness when switched off and on', async () => {
    await executeCommand('off', {}, 'onOff');
    await vi.waitFor(() => expect(controller.posts).toHaveLength(1));
    expect(controller.posts[0].hsv.v).toBe(0);
    await executeCommand('moveToLevel', { level: 254, transitionTime: 0 }, 'levelControl');
    await vi.waitFor(() => expect(controller.posts).toHaveLength(2));
    expect(controller.posts[1].hsv.v).toBe(0);
    await executeCommand('toggle', {}, 'onOff');
    await vi.waitFor(() => expect(controller.posts).toHaveLength(3));
    expect(controller.posts[2].hsv.v).toBe(100);
    await executeCommand('toggle', {}, 'onOff');
    await vi.waitFor(() => expect(controller.posts).toHaveLength(4));
    expect(controller.posts[3].hsv.v).toBe(0);
  });

  test('should switch off when moveToLevelWithOnOff reaches the minimum level', async () => {
    await executeCommand('moveToLevelWithOnOff', { level: 200, transitionTime: 0 }, 'levelControl');
    await vi.waitFor(() => expect(controller.posts).toHaveLength(1));
    expect(controller.posts[0].hsv.v).toBe(78.74);
    await executeCommand('moveToLevelWithOnOff', { level: 1, transitionTime: 0 }, 'levelControl');
    await vi.waitFor(() => expect(controller.posts).toHaveLength(2));
    expect(controller.posts[1].hsv.v).toBe(0);
  });

  test('should use the white channels when the color temperature changes', async () => {
    await executeCommand('moveToColorTemperature', { colorTemperatureMireds: 370, transitionTime: 0 }, 'colorControl');
    await executeCommand('identify', { identifyTime: 5 }, 'identify');
    await vi.waitFor(() => expect(controller.posts).toHaveLength(1));
    expect(controller.posts[0].hsv).toMatchObject({ s: 0, ct: 2703 });
    expect(loggerLogSpy).toHaveBeenCalledWith(LogLevel.INFO, 'Identify called with identifyTime 5');
  });

  test('should poll the controller state when configured', async () => {
    controller.getColorCount = 0;
    controller.hsv = { h: 120, s: 50, v: 20, ct: 0 };
    await instance.onConfigure();
    expect(mockLog.info).toHaveBeenCalledWith('Configuring platform matterbridge-rgbww-led-controller...');
    await vi.waitFor(() => expect(controller.getColorCount).toBeGreaterThanOrEqual(1));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(loggerLogSpy).toHaveBeenCalledWith(LogLevel.DEBUG, expect.stringContaining('Status poll h:120 s:50 v:20 ct:2700'));
  });

  test('should change logger level', async () => {
    await instance.onChangeLoggerLevel(LogLevel.DEBUG);
    expect(mockLog.info).toHaveBeenCalledWith('onChangeLoggerLevel called with: debug');
    expect(instance.getDevices()[0].log.logLevel).toBe(LogLevel.DEBUG);
  });

  test('should shutdown', async () => {
    await instance.onShutdown('Vitest');
    expect(mockLog.info).toHaveBeenCalledWith('Shutting down platform matterbridge-rgbww-led-controller with reason: Vitest...');
    expect(removeAllBridgedEndpoints).not.toHaveBeenCalled();

    mockConfig.unregisterOnShutdown = true;
    await instance.onShutdown();
    expect(removeAllBridgedEndpoints).toHaveBeenCalled();
    mockConfig.unregisterOnShutdown = false;
  });
});
