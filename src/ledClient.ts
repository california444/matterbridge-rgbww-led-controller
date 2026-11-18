/**
 * @file src/ledClient.ts
 * @description HTTP client for the ESP RGBWW LED controller firmware.
 * @author Roman Schlich
 * @created 2026-09-15
 * @version 1.0.1
 * @license Apache-2.0
 *
 * API spec: https://github.com/verybadsoldier/esp_rgbww_firmware/wiki/HTTP-Interface
 */

import { type IncomingMessage, request as httpRequest } from 'node:http';

import { type HsvColor, isRecord, parseHsvColor } from './mapping.js';

/** Subset of the `/info` response used by the plugin. */
export interface ControllerInfo {
  /** Chip id of the controller. */
  deviceId?: string;
  /** Firmware version, e.g. `vbs35`. */
  firmwareVersion?: string;
  /** MAC address without separators. */
  macAddress?: string;
}

type HttpMethod = 'GET' | 'POST';

/**
 * Normalize a configured host name to `host[:port]`.
 *
 * @param {string} hostName Host name or IP, optionally with scheme, port or trailing slash.
 * @returns {string} The normalized host.
 */
export function normalizeHostName(hostName: string): string {
  return hostName
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

/**
 * HTTP client for one LED controller.
 *
 * The ESP8266 web server handles only a few connections at a time, so every request uses its own
 * connection that is closed afterwards (no keep-alive pooling).
 */
export class LedControllerClient {
  readonly host: string;

  /**
   * Create a client.
   *
   * @param {string} hostName Host name or IP of the controller (optionally with port).
   * @param {number} timeoutMs Request timeout in milliseconds.
   */
  constructor(
    hostName: string,
    private readonly timeoutMs = 5000,
  ) {
    this.host = normalizeHostName(hostName);
  }

  /**
   * Read the current color.
   *
   * @returns {Promise<HsvColor>} The current HSV color.
   * @throws {Error} When the request fails or the response is invalid.
   */
  async getColor(): Promise<HsvColor> {
    const body = await this.request('GET', '/color');
    const color = isRecord(body) ? parseHsvColor(body.hsv) : undefined;
    if (!color) throw new Error(`Invalid /color response from ${this.host}`);
    return color;
  }

  /**
   * Fade to a new color.
   *
   * @param {HsvColor} color Target color.
   * @param {number} transitionMs Fade duration in milliseconds.
   * @returns {Promise<void>} Resolves when the controller accepted the command.
   * @throws {Error} When the request fails.
   */
  async setColor(color: HsvColor, transitionMs: number): Promise<void> {
    await this.request('POST', '/color', JSON.stringify({ hsv: color, cmd: 'fade', t: Math.max(0, Math.round(transitionMs)) }));
  }

  /**
   * Read controller information.
   *
   * @returns {Promise<ControllerInfo>} Device id, firmware version and MAC address when available.
   * @throws {Error} When the request fails.
   */
  async getInfo(): Promise<ControllerInfo> {
    const body = await this.request('GET', '/info');
    if (!isRecord(body)) return {};
    const connection = isRecord(body.connection) ? body.connection : {};
    return {
      deviceId: typeof body.deviceid === 'string' ? body.deviceid : undefined,
      firmwareVersion: typeof body.git_version === 'string' ? body.git_version : undefined,
      macAddress: typeof connection.mac === 'string' ? connection.mac : undefined,
    };
  }

  /**
   * Execute a request and parse the JSON response.
   *
   * @param {HttpMethod} method HTTP method.
   * @param {string} path Request path.
   * @param {string} [body] JSON request body.
   * @returns {Promise<unknown>} The parsed body, or undefined for an empty body.
   * @throws {Error} On network errors, timeouts, non-2xx status or invalid JSON.
   */
  private async request(method: HttpMethod, path: string, body?: string): Promise<unknown> {
    const text = await this.send(method, path, body);
    if (text.trim() === '') return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${method} ${path} on ${this.host} returned invalid JSON: ${text}`);
    }
  }

  /**
   * Send a request on a dedicated connection and collect the response text.
   *
   * @param {HttpMethod} method HTTP method.
   * @param {string} path Request path.
   * @param {string} [body] JSON request body.
   * @returns {Promise<string>} The response body.
   * @throws {Error} On network errors, timeouts or non-2xx status.
   */
  private async send(method: HttpMethod, path: string, body?: string): Promise<string> {
    const url = new URL(`http://${this.host}`);
    const headers: Record<string, string | number> = {};
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json;charset=utf-8';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    return new Promise<string>((resolve, reject) => {
      const request = httpRequest(
        { hostname: url.hostname, port: url.port || 80, path, method, headers, agent: false, timeout: this.timeoutMs },
        (response: IncomingMessage): void => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer): void => {
            chunks.push(chunk);
          });
          response.on('error', (error: Error): void => reject(this.createRequestError(method, path, error)));
          response.on('end', (): void => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = response.statusCode ?? 0;
            if (status >= 200 && status < 300) resolve(text);
            else reject(new Error(`${method} ${path} on ${this.host} failed with status ${status}: ${text}`));
          });
        },
      );
      request.on('timeout', (): void => {
        request.destroy(new Error(`timeout after ${this.timeoutMs} ms`));
      });
      request.on('error', (error: Error): void => reject(this.createRequestError(method, path, error)));
      request.end(body);
    });
  }

  /**
   * Build a descriptive error for a failed request.
   *
   * @param {HttpMethod} method HTTP method.
   * @param {string} path Request path.
   * @param {NodeJS.ErrnoException} error The original error.
   * @returns {Error} Error with method, path, host and error code.
   */
  private createRequestError(method: HttpMethod, path: string, error: NodeJS.ErrnoException): Error {
    const code = error.code && !error.message.includes(error.code) ? `${error.code} ` : '';
    return new Error(`${method} ${path} on ${this.host} failed: ${code}${error.message}`, { cause: error });
  }
}
