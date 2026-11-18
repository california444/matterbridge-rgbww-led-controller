/**
 * @file vitest/eventClient.test.ts
 * @description Tests for the JSON stream parser and the event server client against a local TCP server.
 * @author Roman Schlich
 */

/* oxlint-disable typescript/explicit-function-return-type */

import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';

import { JsonObjectStreamParser, LedEventClient } from '../src/eventClient.js';
import type { HsvColor } from '../src/mapping.js';

const COLOR_EVENT_1 =
  '{"jsonrpc":"2.0","method":"color_event","params":{"mode":"hsv","raw":{"r":0,"g":0,"b":0,"ww":443,"cw":0},"hsv":{"h":0.00,"s":0.00,"v":43.30,"ct":6135}},"id":61704}';
const COLOR_EVENT_2 =
  '{"jsonrpc":"2.0","method":"color_event","params":{"mode":"hsv","raw":{"r":0,"g":0,"b":0,"ww":1023,"cw":0},"hsv":{"h":0.00,"s":0.00,"v":100.00,"ct":6135}},"id":61705}';
const KEEP_ALIVE = '{"jsonrpc":"2.0","method":"keep_alive","id":61703}';

describe('JsonObjectStreamParser', () => {
  test('should split objects when there is no delimiter', () => {
    const parser = new JsonObjectStreamParser();
    expect(parser.push(KEEP_ALIVE + COLOR_EVENT_1 + COLOR_EVENT_2)).toHaveLength(3);
  });

  test('should split objects when they are separated by newlines', () => {
    const parser = new JsonObjectStreamParser();
    expect(parser.push(`${KEEP_ALIVE}\r\n${COLOR_EVENT_1}\n \n${COLOR_EVENT_2}\n`)).toHaveLength(3);
  });

  test('should join objects split across chunks', () => {
    const parser = new JsonObjectStreamParser();
    expect(parser.push(COLOR_EVENT_1.slice(0, 40))).toEqual([]);
    const messages = parser.push(COLOR_EVENT_1.slice(40) + KEEP_ALIVE.slice(0, 5));
    expect(messages).toEqual([JSON.parse(COLOR_EVENT_1)]);
    expect(parser.push(KEEP_ALIVE.slice(5))).toEqual([JSON.parse(KEEP_ALIVE)]);
  });

  test('should ignore braces and escaped quotes inside strings', () => {
    const parser = new JsonObjectStreamParser();
    expect(parser.push('{"name":"a}\\"{b"}{"x":1}')).toEqual([{ name: 'a}"{b' }, { x: 1 }]);
  });

  test('should drop invalid objects and garbage between objects', () => {
    const parser = new JsonObjectStreamParser();
    expect(parser.push('garbage{invalid}more{"ok":true}')).toEqual([{ ok: true }]);
  });

  test('should discard an unterminated object when it exceeds the buffer limit', () => {
    const parser = new JsonObjectStreamParser();
    expect(parser.push(`{"x":"${'a'.repeat(70_000)}`)).toEqual([]);
    expect(parser.push('"}{"ok":1}')).toEqual([{ ok: 1 }]);
  });
});

describe('LedEventClient', () => {
  let server: Server;
  let port: number;
  let sockets: Socket[];
  let onConnection: (socket: Socket) => void;
  let client: LedEventClient | undefined;

  beforeEach(async () => {
    sockets = [];
    onConnection = () => {};
    server = createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => {});
      onConnection(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    client?.stop();
    client = undefined;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('should emit colors when the server sends color events', async () => {
    const colors: HsvColor[] = [];
    const states: boolean[] = [];
    onConnection = (socket) => socket.write(KEEP_ALIVE + COLOR_EVENT_1 + '{"jsonrpc":"2.0","method":"transition_finished","params":{"name":"x"}}' + COLOR_EVENT_2);
    client = new LedEventClient({ host: '127.0.0.1', port }, { onColor: (color) => colors.push(color), onConnectionChange: (connected) => states.push(connected) });
    client.start();
    client.start();
    await vi.waitFor(() => expect(colors).toHaveLength(2));
    expect(colors).toEqual([
      { h: 0, s: 0, v: 43.3, ct: 6135 },
      { h: 0, s: 0, v: 100, ct: 6135 },
    ]);
    expect(client.isConnected).toBe(true);
    expect(states).toEqual([true]);
    expect(sockets).toHaveLength(1);
  });

  test('should ignore color events with invalid params', async () => {
    const colors: HsvColor[] = [];
    onConnection = (socket) => socket.write('{"method":"color_event"}{"method":"color_event","params":{"hsv":{"h":"x"}}}' + COLOR_EVENT_2);
    client = new LedEventClient({ host: '127.0.0.1', port }, { onColor: (color) => colors.push(color) });
    client.start();
    await vi.waitFor(() => expect(colors).toHaveLength(1));
  });

  test('should reconnect when the server closes the connection', async () => {
    const states: boolean[] = [];
    client = new LedEventClient(
      { host: '127.0.0.1', port, reconnectMinMs: 20, reconnectMaxMs: 40 },
      { onColor: () => {}, onConnectionChange: (connected) => states.push(connected) },
    );
    client.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].destroy();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await vi.waitFor(() => expect(states).toEqual([true, false, true]));
  });

  test('should reconnect when no keep alive arrives within the watchdog time', async () => {
    client = new LedEventClient({ host: '127.0.0.1', port, reconnectMinMs: 20, watchdogMs: 100 }, { onColor: () => {} });
    client.start();
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(2), { timeout: 2000 });
  });

  test('should report the error and retry when the server is not available', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const errors: (string | undefined)[] = [];
    client = new LedEventClient(
      { host: '127.0.0.1', port, reconnectMinMs: 20 },
      { onColor: () => {}, onConnectionChange: (connected, error) => errors.push(connected ? 'connected' : error) },
    );
    client.start();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(2));
    expect(errors[0]).toContain('ECONNREFUSED');
    expect(client.isConnected).toBe(false);
    client.stop();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  });

  test('should time out when the connection cannot be established', async () => {
    const errors: (string | undefined)[] = [];
    // 10.255.255.1 is a non-routable address, the connect attempt hangs until the timeout.
    client = new LedEventClient(
      { host: '10.255.255.1', port: 9090, connectTimeoutMs: 50, reconnectMinMs: 10_000 },
      { onColor: () => {}, onConnectionChange: (_connected, error) => errors.push(error) },
    );
    client.start();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatch(/connect timeout|EHOSTUNREACH|ENETUNREACH/);
  });

  test('should not reconnect when stopped', async () => {
    client = new LedEventClient({ host: '127.0.0.1', port, reconnectMinMs: 20 }, { onColor: () => {} });
    client.start();
    await vi.waitFor(() => expect(client?.isConnected).toBe(true));
    client.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sockets).toHaveLength(1);
    expect(client.isConnected).toBe(false);
  });
});
