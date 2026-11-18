/**
 * @file vitest/mapping.test.ts
 * @description Tests for the Matter <-> firmware value conversions.
 * @author Roman Schlich
 */

import {
  brightnessToLevel,
  clamp,
  degreesToHue,
  hueToDegrees,
  isRecord,
  kelvinToMireds,
  levelToBrightness,
  miredsToKelvin,
  parseHsvColor,
  percentToSaturation,
  saturationToPercent,
} from '../src/mapping.js';

describe('mapping', () => {
  test('should clamp values into the range', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(5, 0, 10)).toBe(5);
  });

  test('should convert level to brightness when level is in range', () => {
    expect(levelToBrightness(254)).toBe(100);
    expect(levelToBrightness(127)).toBe(50);
    expect(levelToBrightness(1)).toBe(0.39);
  });

  test('should return 0 brightness when level is invalid', () => {
    expect(levelToBrightness(0)).toBe(0);
    expect(levelToBrightness(Number.NaN)).toBe(0);
    expect(levelToBrightness(300)).toBe(100);
  });

  test('should convert brightness to level when brightness is in range', () => {
    expect(brightnessToLevel(100)).toBe(254);
    expect(brightnessToLevel(43.3)).toBe(110);
    expect(brightnessToLevel(0.1)).toBe(1);
  });

  test('should return minimum level when brightness is 0 or invalid', () => {
    expect(brightnessToLevel(0)).toBe(1);
    expect(brightnessToLevel(Number.NaN)).toBe(1);
    expect(brightnessToLevel(150)).toBe(254);
  });

  test('should convert hue in both directions', () => {
    expect(hueToDegrees(254)).toBe(360);
    expect(hueToDegrees(127)).toBe(180);
    expect(hueToDegrees(Number.NaN)).toBe(0);
    expect(degreesToHue(360)).toBe(254);
    expect(degreesToHue(161.58)).toBe(114);
    expect(degreesToHue(Number.NaN)).toBe(0);
    expect(degreesToHue(400)).toBe(254);
  });

  test('should convert saturation in both directions', () => {
    expect(saturationToPercent(254)).toBe(100);
    expect(saturationToPercent(Number.NaN)).toBe(0);
    expect(percentToSaturation(100)).toBe(254);
    expect(percentToSaturation(62.37)).toBe(158);
    expect(percentToSaturation(Number.NaN)).toBe(0);
    expect(percentToSaturation(-5)).toBe(0);
  });

  test('should convert mireds to kelvin with clamping', () => {
    expect(miredsToKelvin(370)).toBe(2703);
    expect(miredsToKelvin(100)).toBe(6494);
    expect(miredsToKelvin(1000)).toBe(2000);
    expect(miredsToKelvin(0)).toBe(2700);
    expect(miredsToKelvin(Number.NaN)).toBe(2700);
  });

  test('should convert kelvin to mireds with clamping', () => {
    expect(kelvinToMireds(6135)).toBe(163);
    expect(kelvinToMireds(2700)).toBe(370);
    expect(kelvinToMireds(10_000)).toBe(154);
    expect(kelvinToMireds(1000)).toBe(500);
    expect(kelvinToMireds(0)).toBe(370);
  });

  test('should detect plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  test('should parse a firmware hsv object', () => {
    expect(parseHsvColor({ h: 161.58, s: 62.37, v: 100, ct: 2746 })).toEqual({ h: 161.58, s: 62.37, v: 100, ct: 2746 });
  });

  test('should default ct to 2700 when ct is 0 or missing', () => {
    expect(parseHsvColor({ h: 0, s: 0, v: 0, ct: 0 })).toEqual({ h: 0, s: 0, v: 0, ct: 2700 });
    expect(parseHsvColor({ h: 0, s: 0, v: 0 })).toEqual({ h: 0, s: 0, v: 0, ct: 2700 });
  });

  test('should clamp hsv values into their ranges', () => {
    expect(parseHsvColor({ h: 400, s: -1, v: 101, ct: 3000 })).toEqual({ h: 360, s: 0, v: 100, ct: 3000 });
  });

  test('should reject invalid hsv objects', () => {
    expect(parseHsvColor(null)).toBeUndefined();
    expect(parseHsvColor({ h: '1', s: 0, v: 0 })).toBeUndefined();
    expect(parseHsvColor({ h: Number.NaN, s: 0, v: 0 })).toBeUndefined();
  });
});
