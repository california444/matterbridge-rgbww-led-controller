/**
 * @file src/eventClient.ts
 * @description Client for the JSON-RPC event server (TCP port 9090) of the ESP RGBWW firmware.
 * @author Roman Schlich
 * @created 2026-09-15
 * @version 1.0.0
 * @license Apache-2.0
 *
 * Spec: https://github.com/verybadsoldier/esp_rgbww_firmware/wiki/JSON-RPC-Event-Server
 */

import { createConnection, type Socket } from 'node:net';

import { type HsvColor, isRecord, parseHsvColor } from './mapping.js';

const MAX_BUFFER_LENGTH = 64 * 1024;

/**
 * Incremental parser for a stream of JSON objects.
 *
 * The firmware does not document a delimiter between messages, so objects are split by brace depth.
 * Whitespace and newlines between objects are ignored, strings and escapes are respected.
 */
export class JsonObjectStreamParser {
  private buffer = '';
  private depth = 0;
  private inString = false;
  private escaped = false;

  /**
   * Feed a chunk and return all complete objects.
   *
   * Edge cases:
   *  - characters outside of an object are skipped
   *  - objects with invalid JSON are dropped
   *  - an unterminated object longer than 64 KiB is discarded
   *
   * @param {string} chunk Received text.
   * @returns {unknown[]} Parsed objects in order.
   */
  push(chunk: string): unknown[] {
    const messages: unknown[] = [];
    for (const char of chunk) {
      if (this.depth === 0) {
        if (char !== '{') continue;
        this.buffer = '';
      }
      this.buffer += char;
      this.consume(char);
      if (this.depth === 0) {
        const message = this.parseBuffer();
        if (message !== undefined) messages.push(message);
      } else if (this.buffer.length > MAX_BUFFER_LENGTH) {
        this.reset();
      }
    }
    return messages;
  }

  /** Discard any partial object. */
  reset(): void {
    this.buffer = '';
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
  }

  /**
   * Update the nesting state for one character inside an object.
   *
   * @param {string} char The character.
   */
  private consume(char: string): void {
    if (this.inString) {
      if (this.escaped) this.escaped = false;
      else if (char === '\\') this.escaped = true;
      else if (char === '"') this.inString = false;
      return;
    }
    if (char === '"') this.inString = true;
    else if (char === '{') this.depth++;
    else if (char === '}') this.depth--;
  }

  /**
   * Parse the buffered complete object.
   *
   * @returns {unknown} The parsed object or undefined when invalid.
   */
  private parseBuffer(): unknown {
    const text = this.buffer;
    this.buffer = '';
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
}

/** Options for {@link LedEventClient}. */
export interface LedEventClientOptions {
  /** Host name or IP of the controller (without port). */
  host: string;
  /** Event server port, default 9090. */
  port?: number;
  /** First reconnect delay in milliseconds, default 5000. */
  reconnectMinMs?: number;
  /** Maximum reconnect delay in milliseconds, default 60000. */
  reconnectMaxMs?: number;
  /** Reconnect when no data arrived for this long, default 90000 (firmware sends keep_alive every 60 s). */
  watchdogMs?: number;
  /** Connect timeout in milliseconds, default 5000. */
  connectTimeoutMs?: number;
}

/** Callbacks of {@link LedEventClient}. */
export interface LedEventClientHandlers {
  /** Called for every valid `color_event`. */
  onColor: (color: HsvColor) => void;
  /** Called when the connection state changes. */
  onConnectionChange?: (connected: boolean, error?: string) => void;
}

/** Persistent connection to the firmware event server with reconnect and keep-alive watchdog. */
export class LedEventClient {
  private readonly host: string;
  private readonly port: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly watchdogMs: number;
  private readonly connectTimeoutMs: number;
  private readonly parser = new JsonObjectStreamParser();
  private socket?: Socket;
  private reconnectTimer?: NodeJS.Timeout;
  private watchdogTimer?: NodeJS.Timeout;
  private reconnectDelayMs: number;
  private running = false;
  private connected = false;
  private lastError?: string;

  /**
   * Create an event client. Call {@link start} to connect.
   *
   * @param {LedEventClientOptions} options Connection options.
   * @param {LedEventClientHandlers} handlers Event callbacks.
   */
  constructor(
    options: LedEventClientOptions,
    private readonly handlers: LedEventClientHandlers,
  ) {
    this.host = options.host;
    this.port = options.port ?? 9090;
    this.reconnectMinMs = options.reconnectMinMs ?? 5000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 60_000;
    this.watchdogMs = options.watchdogMs ?? 90_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.reconnectDelayMs = this.reconnectMinMs;
  }

  /**
   * Whether the event server is currently connected.
   *
   * @returns {boolean} True when connected.
   */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Connect and keep reconnecting until {@link stop} is called. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  /** Close the connection and stop reconnecting. */
  stop(): void {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.watchdogTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
    this.setConnected(false);
  }

  /** Open a new socket. */
  private connect(): void {
    this.reconnectTimer = undefined;
    this.parser.reset();
    const socket = createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setTimeout(this.connectTimeoutMs);
    socket.once('connect', () => {
      socket.setTimeout(0);
      this.reconnectDelayMs = this.reconnectMinMs;
      this.lastError = undefined;
      this.setConnected(true);
      this.resetWatchdog(socket);
    });
    socket.on('timeout', () => socket.destroy(new Error('connect timeout')));
    socket.on('data', (chunk: string) => {
      this.resetWatchdog(socket);
      for (const message of this.parser.push(chunk)) this.handleMessage(message);
    });
    socket.on('error', (error) => {
      this.lastError = error.message;
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      clearTimeout(this.watchdogTimer);
      this.setConnected(false);
      this.scheduleReconnect();
    });
  }

  /** Schedule the next connection attempt with exponential backoff. */
  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /**
   * Restart the keep-alive watchdog for a socket.
   *
   * @param {Socket} socket The active socket.
   */
  private resetWatchdog(socket: Socket): void {
    clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => socket.destroy(new Error('keep-alive timeout')), this.watchdogMs);
  }

  /**
   * Dispatch one JSON-RPC message.
   *
   * @param {unknown} message The parsed message.
   */
  private handleMessage(message: unknown): void {
    if (!isRecord(message) || message.method !== 'color_event' || !isRecord(message.params)) return;
    const color = parseHsvColor(message.params.hsv);
    if (color) this.handlers.onColor(color);
  }

  /**
   * Update and report the connection state (also reports every failed attempt while disconnected).
   *
   * @param {boolean} connected New state.
   */
  private setConnected(connected: boolean): void {
    if (this.connected === connected && (connected || this.lastError === undefined)) return;
    this.connected = connected;
    this.handlers.onConnectionChange?.(connected, connected ? undefined : this.lastError);
    if (!connected) this.lastError = undefined;
  }
}
