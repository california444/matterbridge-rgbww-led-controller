# matterbridge-rgbww-led-controller

[![powered by](https://img.shields.io/badge/powered%20by-matterbridge-blue)](https://www.npmjs.com/package/matterbridge)

Matterbridge plugin for the [ESP RGBWW LED controller](https://forum.fhem.de/index.php?topic=70738.0) running the [esp_rgbww_firmware](https://github.com/verybadsoldier/esp_rgbww_firmware).
Each controller is exposed as a Matter **Extended Color Light** (on/off, brightness, hue/saturation, color temperature) and works with every Matter controller (Apple Home, Google Home, Alexa, Home Assistant, SmartThings).

This plugin is the Matterbridge successor of [homebridge-rgbww-led-controller](https://github.com/california444/homebridge-led-controller).

## Features

- Any number of LED controllers per plugin instance.
- Smooth fades for all changes (`cmd: "fade"`, configurable transition time).
- Instant state updates via the firmware's JSON-RPC event server (TCP port 9090), with automatic fallback to HTTP polling when it is not available.
- Switching on restores the last brightness.
- Color temperature commands use the white channels (saturation 0).
- The device is marked unreachable when the controller does not respond.

## Requirements

- Matterbridge >= 3.10.9
- Node.js 22.13, 24 or 26
- ESP RGBWW firmware with HTTP API (tested with `vbs35` / rgbww `0.8.1-vbs5`)

## Installation

Install the plugin from the Matterbridge frontend (search for `matterbridge-rgbww-led-controller`) or on the command line:

```sh
npm install -g matterbridge-rgbww-led-controller
matterbridge -add matterbridge-rgbww-led-controller
```

## Configuration

Configure the plugin in the Matterbridge frontend:

```json
{
  "name": "matterbridge-rgbww-led-controller",
  "type": "DynamicPlatform",
  "devices": [
    { "name": "LED-Strip Kitchen", "hostName": "192.168.1.50" },
    { "name": "LED-Strip Living Room", "hostName": "192.168.1.51" }
  ],
  "transitionMs": 600,
  "useEventServer": true,
  "pollIntervalSeconds": 300
}
```

| Option                | Default | Description                                                                           |
| --------------------- | ------- | ------------------------------------------------------------------------------------- |
| `devices`             | `[]`    | List of controllers with `name` and `hostName` (IP address or host name).             |
| `transitionMs`        | `600`   | Fade duration in milliseconds.                                                        |
| `useEventServer`      | `true`  | Receive state changes from the event server on port 9090. Falls back to polling.      |
| `pollIntervalSeconds` | `300`   | Interval for reading the state via HTTP (minimum 10). Use a lower value without push. |
| `whiteList`           | `[]`    | Only expose these device names.                                                       |
| `blackList`           | `[]`    | Do not expose these device names.                                                     |

The host name is used as serial number. Changing it creates a new Matter device.

`transitionMs` is the only fade duration in use. It is sent to the controller as `t` and appears in the log as `Setting color … t:600`. It has nothing to do with the `transitionTime` of a Matter command, which the Matter controller sends in 1/10 s and which the plugin ignores. Apple Home sends `transitionTime 0` for every color change, so a `0` in the `MatterbridgeColorControlServer: …` log lines is expected.

### Check the event server

```sh
nc -v 192.168.1.50 9090
```

If the connection succeeds you will see a `keep_alive` message every 60 seconds and `color_event` messages when the color changes. If the connection is refused, enable `events/server_enabled` in the controller configuration or keep using polling. The firmware accepts at most 4 event clients.

During a fade the firmware reports intermediate colors and its last `color_event` does not have to carry the target color. Those reports are ignored while the plugin's own fade is running, and the state is read once from `/color` after the fade, also with the event server connected. Enable `debug` to see this in the log: `Push update …` for every event, `Ignoring color during fade …` for the ones that are dropped and `Status poll …` for the settling read.

### Migration from Homebridge

Every `RGBWW-LED-Controller` accessory of the Homebridge config becomes one entry in `devices` with the same `name` and `hostName`.

## Development

```sh
npm install           # also installs matterbridge as devDependency for build and tests
npm run build
npm run test
npm run lint
npm run format
npm run check         # format check, lint, typecheck and tests with coverage, run before a release
```

Build a package to upload in the Matterbridge frontend:

```sh
npm pack              # production build, creates matterbridge-rgbww-led-controller-<version>.tgz
```

Source layout:

| File                 | Purpose                                                       |
| -------------------- | ------------------------------------------------------------- |
| `src/module.ts`      | Platform: config handling, device registration, lifecycle.    |
| `src/ledDevice.ts`   | Matter endpoint, command handlers, state sync and debouncing. |
| `src/ledClient.ts`   | HTTP client for `/color` and `/info`.                         |
| `src/eventClient.ts` | Event server client with stream parser, reconnect, watchdog.  |
| `src/mapping.ts`     | Value conversions between Matter and the firmware.            |

### Publishing

Releases are created by the `Release` workflow on every push to `main` whose `package.json` version has no tag yet. It runs the `Build` workflow, creates the tag `v<version>` with a GitHub release and publishes to npm with trusted publishing (no npm token in the repository). Versions with a `-` (e.g. `1.1.0-beta.1`) are prereleases and go to the npm tag `beta`.

1. Raise the version with `npm version <patch|minor|major> --no-git-tag-version`.
2. Merge to `main`. The release is created with notes listing the merged pull requests, the npm job waits for approval in the `npm` environment.

An existing tag can be published again with _Run workflow_ on the `Release` workflow (tag and channel `latest` or `beta`).

One-time setup:

- Publish the first version manually with `npm login` and `npm publish --access public`, then configure trusted publishing for `california444/matterbridge-rgbww-led-controller` with the workflow `release.yml` on npmjs.com.
- Create the environment `npm` with a required reviewer and the repository variable `NPM_PUBLISH=true` in the GitHub repository settings.

Based on the [Matterbridge plugin template](https://github.com/Luligu/matterbridge-plugin-template) by Luca Liguori. See also the Matterbridge [development guide](https://matterbridge.io/README-DEV.html).
