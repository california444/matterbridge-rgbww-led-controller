/**
 * @file vitest/ledClient.test.ts
 * @description Tests for the LED controller HTTP client against a local fake controller.
 * @author Roman Schlich
 */

/* oxlint-disable typescript/explicit-function-return-type */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { LedControllerClient, normalizeHostName } from '../src/ledClient.js';

type Handler = (request: IncomingMessage, body: string, response: ServerResponse) => void;

describe('LedControllerClient', () => {
  let server: Server;
  let host: string;
  let handler: Handler;

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => handler(request, body, response));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('should normalize host names', () => {
    expect(normalizeHostName(' http://192.168.1.50/ ')).toBe('192.168.1.50');
    expect(normalizeHostName('HTTPS://led.local:8080//')).toBe('led.local:8080');
    expect(normalizeHostName('192.168.1.50')).toBe('192.168.1.50');
  });

  test('should read the color when the controller responds', async () => {
    handler = (request, _body, response) => {
      expect(request.method).toBe('GET');
      expect(request.url).toBe('/color');
      response.end('{"raw":{"r":0,"g":0,"b":0,"ww":0,"cw":0},"hsv":{"h":0.00,"s":0.00,"v":43.30,"ct":0}}');
    };
    await expect(new LedControllerClient(host).getColor()).resolves.toEqual({ h: 0, s: 0, v: 43.3, ct: 2700 });
  });

  test('should throw when the color response is invalid', async () => {
    handler = (_request, _body, response) => response.end('{"raw":{}}');
    await expect(new LedControllerClient(host).getColor()).rejects.toThrow('Invalid /color response');
    handler = (_request, _body, response) => response.end('');
    await expect(new LedControllerClient(host).getColor()).rejects.toThrow('Invalid /color response');
  });

  test('should post a fade command when setting the color', async () => {
    let received: unknown;
    handler = (request, body, response) => {
      expect(request.method).toBe('POST');
      expect(request.headers['content-type']).toBe('application/json;charset=utf-8');
      received = JSON.parse(body);
      response.end('{"success":true}');
    };
    await new LedControllerClient(host).setColor({ h: 10, s: 20, v: 30, ct: 4000 }, 600.4);
    expect(received).toEqual({ hsv: { h: 10, s: 20, v: 30, ct: 4000 }, cmd: 'fade', t: 600 });
  });

  test('should parse the info response', async () => {
    handler = (_request, _body, response) => response.end('{"deviceid":"12345678","git_version":"vbs35","connection":{"connected":true,"ip":"192.168.1.50","mac":"aabbccddeeff"}}');
    await expect(new LedControllerClient(host).getInfo()).resolves.toEqual({ deviceId: '12345678', firmwareVersion: 'vbs35', macAddress: 'aabbccddeeff' });
  });

  test('should return empty info when fields are missing', async () => {
    handler = (_request, _body, response) => response.end('{"deviceid":1}');
    await expect(new LedControllerClient(host).getInfo()).resolves.toEqual({ deviceId: undefined, firmwareVersion: undefined, macAddress: undefined });
    handler = (_request, _body, response) => response.end('[]');
    await expect(new LedControllerClient(host).getInfo()).resolves.toEqual({});
  });

  test('should throw when the status is not ok', async () => {
    handler = (_request, _body, response) => {
      response.statusCode = 500;
      response.end('error');
    };
    await expect(new LedControllerClient(host).getInfo()).rejects.toThrow('failed with status 500: error');
  });

  test('should throw when the response is not json', async () => {
    handler = (_request, _body, response) => response.end('<html>');
    await expect(new LedControllerClient(host).getInfo()).rejects.toThrow('returned invalid JSON');
  });

  test('should throw when the request times out', async () => {
    handler = () => {};
    await expect(new LedControllerClient(host, 100).getColor()).rejects.toThrow(`GET /color on ${host} failed`);
  });

  test('should throw when the controller is not reachable', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const closedHost = `127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await expect(new LedControllerClient(closedHost).setColor({ h: 0, s: 0, v: 0, ct: 2700 }, 0)).rejects.toThrow(`POST /color on ${closedHost} failed`);
  });
});
