/**
 * @file src/mapping.ts
 * @description Value conversions between Matter attributes and the ESP RGBWW firmware HSV model.
 * @author Roman Schlich
 * @created 2026-09-15
 * @version 1.0.0
 * @license Apache-2.0
 */

/** HSV color as used by the ESP RGBWW firmware (`/color` endpoint and `color_event`). */
export interface HsvColor {
  /** Hue in degrees (0..360). */
  h: number;
  /** Saturation in percent (0..100). */
  s: number;
  /** Brightness in percent (0..100). */
  v: number;
  /** Color temperature in Kelvin. */
  ct: number;
}

export const DEFAULT_COLOR_TEMPERATURE_KELVIN = 2700;
export const MIN_COLOR_TEMPERATURE_MIREDS = 154; // 6500 K
export const MAX_COLOR_TEMPERATURE_MIREDS = 500; // 2000 K
export const MIN_LEVEL = 1;
export const MAX_LEVEL = 254;
export const MAX_HUE = 254;
export const MAX_SATURATION = 254;

/**
 * Clamp a number into a range.
 *
 * @param {number} value Value to clamp.
 * @param {number} min Lower bound.
 * @param {number} max Upper bound.
 * @returns {number} The clamped value.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Round a number to two decimals.
 *
 * @param {number} value Value to round.
 * @returns {number} The rounded value.
 */
function roundTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Convert a Matter level to firmware brightness.
 *
 * Edge cases:
 *  - non-finite or <= 0 -> 0
 *  - clamps to 1..254 before conversion
 *
 * @param {number} level Matter currentLevel (1..254).
 * @returns {number} Brightness in percent (0..100).
 */
export function levelToBrightness(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0;
  return roundTwoDecimals((clamp(level, MIN_LEVEL, MAX_LEVEL) / MAX_LEVEL) * 100);
}

/**
 * Convert firmware brightness to a Matter level.
 *
 * Edge cases:
 *  - non-finite or <= 0 -> 1 (minimum level, the OnOff attribute carries the off state)
 *
 * @param {number} brightness Brightness in percent (0..100).
 * @returns {number} Matter currentLevel (1..254).
 */
export function brightnessToLevel(brightness: number): number {
  if (!Number.isFinite(brightness) || brightness <= 0) return MIN_LEVEL;
  return clamp(Math.round((brightness / 100) * MAX_LEVEL), MIN_LEVEL, MAX_LEVEL);
}

/**
 * Convert a Matter hue to degrees.
 *
 * @param {number} hue Matter currentHue (0..254).
 * @returns {number} Hue in degrees (0..360).
 */
export function hueToDegrees(hue: number): number {
  if (!Number.isFinite(hue)) return 0;
  return roundTwoDecimals((clamp(hue, 0, MAX_HUE) / MAX_HUE) * 360);
}

/**
 * Convert degrees to a Matter hue.
 *
 * @param {number} degrees Hue in degrees (0..360).
 * @returns {number} Matter currentHue (0..254).
 */
export function degreesToHue(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  return clamp(Math.round((degrees / 360) * MAX_HUE), 0, MAX_HUE);
}

/**
 * Convert a Matter saturation to percent.
 *
 * @param {number} saturation Matter currentSaturation (0..254).
 * @returns {number} Saturation in percent (0..100).
 */
export function saturationToPercent(saturation: number): number {
  if (!Number.isFinite(saturation)) return 0;
  return roundTwoDecimals((clamp(saturation, 0, MAX_SATURATION) / MAX_SATURATION) * 100);
}

/**
 * Convert percent to a Matter saturation.
 *
 * @param {number} percent Saturation in percent (0..100).
 * @returns {number} Matter currentSaturation (0..254).
 */
export function percentToSaturation(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return clamp(Math.round((percent / 100) * MAX_SATURATION), 0, MAX_SATURATION);
}

/**
 * Convert mireds to Kelvin.
 *
 * Edge cases:
 *  - non-finite or <= 0 -> default 2700 K
 *  - clamps to the supported mireds range (154..500)
 *
 * @param {number} mireds Color temperature in mireds.
 * @returns {number} Color temperature in Kelvin.
 */
export function miredsToKelvin(mireds: number): number {
  if (!Number.isFinite(mireds) || mireds <= 0) return DEFAULT_COLOR_TEMPERATURE_KELVIN;
  return Math.round(1_000_000 / clamp(mireds, MIN_COLOR_TEMPERATURE_MIREDS, MAX_COLOR_TEMPERATURE_MIREDS));
}

/**
 * Convert Kelvin to mireds.
 *
 * Edge cases:
 *  - non-finite or <= 0 -> mireds of the default 2700 K
 *  - clamps to the supported mireds range (154..500)
 *
 * @param {number} kelvin Color temperature in Kelvin.
 * @returns {number} Color temperature in mireds.
 */
export function kelvinToMireds(kelvin: number): number {
  const safeKelvin = Number.isFinite(kelvin) && kelvin > 0 ? kelvin : DEFAULT_COLOR_TEMPERATURE_KELVIN;
  return clamp(Math.round(1_000_000 / safeKelvin), MIN_COLOR_TEMPERATURE_MIREDS, MAX_COLOR_TEMPERATURE_MIREDS);
}

/**
 * Check whether a value is a plain object.
 *
 * @param {unknown} value Value to check.
 * @returns {boolean} True when the value is a non-null object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate and normalize an HSV object received from the firmware.
 *
 * Edge cases:
 *  - returns undefined when h, s or v are missing or not finite
 *  - missing, non-finite or 0 ct -> 2700 K (same fallback as the Homebridge plugin)
 *  - h, s and v are clamped to their ranges
 *
 * @param {unknown} value The `hsv` object from the firmware.
 * @returns {HsvColor | undefined} The normalized color or undefined when invalid.
 */
export function parseHsvColor(value: unknown): HsvColor | undefined {
  if (!isRecord(value)) return undefined;
  const { h, s, v, ct } = value;
  if (typeof h !== 'number' || typeof s !== 'number' || typeof v !== 'number') return undefined;
  if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(v)) return undefined;
  const colorTemperature = typeof ct === 'number' && Number.isFinite(ct) && ct > 0 ? ct : DEFAULT_COLOR_TEMPERATURE_KELVIN;
  return { h: clamp(h, 0, 360), s: clamp(s, 0, 100), v: clamp(v, 0, 100), ct: colorTemperature };
}
