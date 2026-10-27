---
title: enig-term Web Terminal
description: "Serve the enig-term browser terminal from /_enig/ws-term/ and point it at your secure WebSocket server."
sidebar:
    order: 4
---
## enig-term

enig-term is a browser terminal for ANSI-BBS boards. It runs the emulation in WebAssembly and draws with WebGL, so callers get CP437 and Amiga fonts, SyncTERM font switching, iCE colours, 4:3 aspect correction and an optional CRT look, with nothing to install. It connects to ENiGMA½'s [WebSocket login server](./websocket.md).

enig-term is its own project, at [github.com/NuSkooler/enig-term](https://github.com/NuSkooler/enig-term). ENiGMA½'s source does not include its files: you install them, and ENiGMA½ serves them at `/_enig/ws-term/` on the [web server](../contentservers/web-server.md). The [install script](../../installation/install-script.md) can install them for you, and the [Docker image](../../installation/docker.md#enig-term-web-terminal) carries a copy.

:::caution[Early release]
enig-term is at version 0.1, and its options and files may still change between versions. [VTX](./websocket.md#vtx-web-client) remains documented as an alternative.
:::

---

## Requirements

- The [web server](../contentservers/web-server.md) enabled over `http` or `https`. The page is served from it.
- A **secure** WebSocket endpoint (`wss://`) that browsers can reach: either ENiGMA½'s own `wss` listener, or a TLS proxy in front of its `ws` listener. See [Deployment Architectures](./websocket.md#deployment-architectures). enig-term connects over `wss://` only.

---

## Installing

The route is **off until you install enig-term**. It answers only while its directory exists and contains an `index.html`; otherwise every request under `/_enig/ws-term/` is a 404. Outside Docker there is nothing else to switch on, and no restart is needed either way.

### With the install script

`install.sh` asks `Install the enig-term web terminal? [y/N]`. Answer `y` and it downloads the latest release, checks it against the release's `SHA256SUMS`, and unpacks it into `ws-term` in your install directory, which turns the route on. Then carry on from step 3 below. Running the script again later installs the latest release over the old one. See [Install Script](../../installation/install-script.md#enig-term).

### With Docker

The image carries enig-term at `/opt/enig-term`, pinned to the release the image was built with, and leaves it off. Turn it on by setting `root`:

```hjson
contentServers: {
    web: {
        wsTerm: {
            root: /opt/enig-term
        }
    }
}
```

Then carry on from step 3 below. See [Docker](../../installation/docker.md#enig-term-web-terminal).

### By hand

1. **Download a release.** Get `enig-term-<version>.zip` (or `.tar.gz`) and `SHA256SUMS` from the [releases page](https://github.com/NuSkooler/enig-term/releases), and check the download:

   ```shell
   sha256sum -c SHA256SUMS --ignore-missing
   unzip enig-term-0.3.0.zip
   ```

   The archive holds one folder, `enig-term-<version>/`, with `index.html`, `enig-term.js`, the `.wasm` files, fonts and licence notices. To build it yourself instead, follow [Building from source](https://github.com/NuSkooler/enig-term/blob/main/docs/building.md); the build writes the same files to `dist/`.

2. **Copy it into place.** The default location is a `ws-term` directory at the top of your ENiGMA½ install, next to `www`:

   ```shell
   mkdir -p /path/to/enigma-bbs/ws-term
   cp -a enig-term-0.3.0/. /path/to/enigma-bbs/ws-term/
   ```

   If the copy includes a `config.json`, delete it unless you mean to use it as an [override](#configjson): while it is there, ENiGMA½ serves it instead of generating one.

3. **Set the endpoint** if ENiGMA½ cannot work it out, which is the case behind a proxy. See [The endpoint](#the-endpoint).

4. **Browse to** `https://your-hostname.here/_enig/ws-term/`.

To upgrade, copy a newer release over the old files. Every file is revalidated on each page load, so callers pick up the new version straight away rather than mixing old and new files from their cache. To remove enig-term, delete the directory.

:::note
Keep the directory outside the web server's `staticRoot` (`www` by default), or its files are served twice: once at `/_enig/ws-term/` and once as plain static files.
:::

---

## Configuration

Settings live under `contentServers.web.wsTerm` in `config.hjson`. All of them are optional.

| Key | Default | Description |
|-----|---------|-------------|
| `root` | `enigma-bbs/ws-term` | Directory enig-term is installed in. A relative path is taken from the ENiGMA½ install directory. It may be a symlink, for example to a build's `dist/`. |
| `endpoint` | `""` | Public `wss://` URL the page connects to. When empty, ENiGMA½ builds one; see below. |
| `client` | `{}` | Options passed through into the generated `config.json` as-is. See enig-term's documentation for what it accepts. |

### The endpoint

The generated `config.json` tells the page where to connect. ENiGMA½ picks the first of these that applies:

1. `wsTerm.endpoint`, when it is set.
2. `wss://<contentServers.web.domain>:<loginServers.webSocket.wss.port>`, when ENiGMA½'s own `wss` listener is enabled.
3. None. ENiGMA½ logs a warning once, and the page asks the caller for a host instead of connecting on its own.

A plain `ws://` listener is never used to build the endpoint, because browsers on an HTTPS page will not connect to it.

**Behind a TLS proxy**, the port browsers use is the proxy's, not the one ENiGMA½ listens on, so set `endpoint` yourself. For example, with ENiGMA½ listening on plain `ws://` port 8810 and a proxy publishing it as `wss://bbs.example.com:44512`:

```hjson
contentServers: {
    web: {
        domain: bbs.example.com
        http: {
            enabled: true
            port: 8080
        }
        wsTerm: {
            endpoint: "wss://bbs.example.com:44512"
        }
    }
}
```

The value is used exactly as written, so it can carry a path when the proxy routes WebSockets on one, such as `"wss://bbs.example.com/wss"`.

### config.json

The page reads `config.json` from its own directory. Unless you put one there, ENiGMA½ generates it on each request from:

- `version`: the format of this file, currently `1`;
- `endpoint`: as described above, or `null`;
- `lockEndpoint`: `true` when there is an endpoint. The page then connects only there, and a link such as `/_enig/ws-term/?endpoint=wss://elsewhere` cannot send your callers to another host. Set `lockEndpoint: false` in `wsTerm.client` only if you want callers to be able to choose a host;
- `title`: your `general.boardName`;
- everything in `wsTerm.client`, merged in last.

For example, with `wsTerm.client` set as follows:

```hjson
contentServers: {
    web: {
        wsTerm: {
            endpoint: "wss://bbs.example.com:44512"
            client: {
                autoConnect: true
                crt: false
            }
        }
    }
}
```

`/_enig/ws-term/config.json` returns:

```json
{
    "version": 1,
    "endpoint": "wss://bbs.example.com:44512",
    "lockEndpoint": true,
    "title": "Another Fine ENiGMA½ BBS",
    "autoConnect": true,
    "crt": false
}
```

**To take full control**, copy your own `config.json` into the `ws-term` directory. ENiGMA½ then serves that file unchanged and ignores the settings above, `endpoint` included.

---

## What ENiGMA½ does for enig-term

enig-term identifies itself when ENiGMA½ asks for Device Attributes, and the debug log records it as `termClient: "enig_term"` with its version. ENiGMA½ then treats it as it treats SyncTERM: rather than going by the name, it asks what the terminal can do, and goes by the answers. In one round trip during connect, it sends:

- `CSI < c`, CTerm Device Attributes (CTDA), which lists the features the terminal has. Font selection (`CSI Ps1 ; Ps2 SP D`) in that list turns SyncTERM font switching on, so art and doors can change fonts (Topaz for the [Amiga door](../../doors/amiga.md), for example);
- `CSI = 6 n`, which asks about OSC 8 hyperlinks. Download links are clickable only when the answer is yes.

The log line `CTerm capabilities (CTDA answered)` shows what the terminal reported, as `termCapabilities`:

```json
{
    "ctda": [1, 2, 3, 5],
    "loadableFonts": true,
    "brightBackground": true,
    "paletteOsc": true,
    "pixelOps": false,
    "fontSelect": true,
    "extendedPalette": false,
    "mouse": false,
    "keyEvents": false,
    "osc8": true
}
```

The numbers are the features as the [CTerm manual](https://syncterm.bbsdev.net/cterm.html) numbers them: 1 fonts loadable by DCS, 2 bright backgrounds (iCE colours), 3 palette changes by OSC, 4 pixel graphics (sixel, PPM), 5 font selection, 6 an extended palette, 7 mouse reports, 8 key press and release reports. Older copies of `cterm.txt` list them in a different order. That was an error in the document: SyncTERM has always sent this numbering.

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| `/_enig/ws-term/` is a 404 | The web server is enabled, and `index.html` is directly inside `wsTerm.root`, not in a `dist` subdirectory of it. |
| The page asks for a host | No endpoint could be worked out. Set `wsTerm.endpoint`, or enable `loginServers.webSocket.wss`. The log has a warning saying the same. |
| The page loads but cannot connect | The endpoint must be `wss://` and reachable from the browser. Open it with your browser's developer tools on the Network tab. See also [Troubleshooting WebSocket & VTX](../../troubleshooting/websocket-troubleshooting.md). |
| Settings in `config.hjson` have no effect | A `config.json` in the `ws-term` directory takes precedence. Delete it. |
