---
title: Docker
description: "Run ENiGMA½ from the official container image, including the volumes you need to persist."
sidebar:
    order: 3
---

:::caution
You'll need Docker installed before going any further. Installing it is out of scope of these docs, but you can find full instructions for every operating system on the [Docker website](https://docs.docker.com/engine/install/).
:::

## Quick Start
Prepare a folder where you are going to save your bbs files.

1. Generate some config for your BBS: \
You can perform this step from anywhere - but make sure to consistently run it from the same place to retain your config inside the docker guest.

```bash
docker run -it -p 8888:8888 \
--name "ENiGMABBS" \
-v "$(pwd)/config:/enigma-bbs/config" \
-v "$(pwd)/db:/enigma-bbs/db" \
-v "$(pwd)/logs:/enigma-bbs/logs" \
-v "$(pwd)/filebase:/enigma-bbs/filebase" \
-v "$(pwd)/art:/enigma-bbs/art" \
-v "$(pwd)/mods:/enigma-bbs/mods" \
-v "$(pwd)/mail:/mail" \
enigmabbs/enigma-bbs:latest
```
2. Run it: \
You can use the same command as above, just daemonize and drop interactiveness (we needed it for config but most of the time docker will run in the background)

```bash
docker run -d -p 8888:8888 \
--name "ENiGMABBS" \
-v "$(pwd)/config:/enigma-bbs/config" \
-v "$(pwd)/db:/enigma-bbs/db" \
-v "$(pwd)/logs:/enigma-bbs/logs" \
-v "$(pwd)/filebase:/enigma-bbs/filebase" \
-v "$(pwd)/art:/enigma-bbs/art" \
-v "$(pwd)/mods:/enigma-bbs/mods" \
-v "$(pwd)/mail:/mail" \
enigmabbs/enigma-bbs:latest
```
### Restarting and Making changes
If you make any changes to your host config folder they will persist, and you can just restart ENiGMABBS container to load any changes you've made.

```bash
docker restart ENiGMABBS
```

`docker stop` and `docker restart` kill the container 10 seconds after asking it to stop, which
can cut ENiGMA½'s shutdown short; `-t 30` gives it longer. See
[Stopping](production.md#stopping).

:::tip
Configuration will be stored in `$(pwd)/enigma-bbs/config`.
:::

:::tip
Windows users — you'll need to switch out `$(pwd)/enigma-bbs/config` for a Windows-style path.
:::

Once the container is up, [test your installation](testing.md).

## Architecture and file transfers

Images are published for `linux/amd64`, `linux/arm64` and `linux/arm/v7`, each built natively,
and every one of them ships a matching `sexyz`. All four default X/Y/ZModem handlers work out
of the box on all three, as does **ZModem 8k** (`zmodem8kSz`), which uses `sz`/`rz` from
`lrzsz`.

The `sexyz` binaries are cross compiled from Synchronet's own source rather than downloaded —
upstream publishes ready-made builds for Win32 only. `docker/sexyz/build.sh` does the build and
`docker/sexyz/manifest.json` records which upstream commit each one came from. The image build
runs `sexyz v` after selecting the binary, so an architecture mismatch fails the build instead
of reaching users (which is what [#797](https://github.com/NuSkooler/enigma-bbs/issues/797)
was).

See [File Transfer Protocols](../configuration/file-transfer-protocols.md) for the full picture.

## Archivers and file descriptions

The image ships every program ENiGMA½'s default [archivers](../configuration/archivers.md) and
description tools call, on all three platforms, so uploads are listed and described with no
setup:

| Program | Used for |
|:--------|:---------|
| `zip`, `unzip` | ZIP (`InfoZip`) |
| `7za` | 7-Zip (`7Zip`) |
| `lha` | LHA/LZH (`Lha`) |
| `arj` | ARJ (`Arj`) |
| `unrar` | RAR (`Rar`): RARLAB's, from Debian non-free |
| `tar` | tar, `.tar.gz` (`TarGz`) |
| `unarc` | ARC/PAK, ZOO, ACE, SQZ, UC2, `.Z`, xz, Zstandard, CAB, C64 Lynx/T64/D64, Amiga DMS, and Amiga LZX and Atari ATR (`Unarc`) |
| `exiftool` | descriptions of PDFs, audio, video and images |
| `xdms` | descriptions of Amiga DMS disks |
| `pdftotext` | PDF text, if you configure it (from `poppler-utils`) |

Debian packages neither `unlzx` nor `atr`, so the image reads LZX and ATR with
[unarc](../configuration/archivers.md#unarc) instead. It sets `ENIGMA_UNARC_ARCHIVERS=Atr,Lzx`,
which points those two archivers at the `Unarc` archiver, as the Archivers page shows for
`config.hjson`. `-e ENIGMA_UNARC_ARCHIVERS=` turns the redirection off. Names must match an
archiver key exactly; others are ignored.

An `Atr` or `Lzx` entry in your own `config.hjson` replaces the redirection outright, so it must
be a *complete* archiver entry, with every operation it needs. A partial one, such as
`Lzx: { list: { cmd: "my-unlzx" } }`, is not merged with anything: it becomes the whole `Lzx`
archiver, and listing an LZX then fails.

`unarc` is built from its [crates.io](https://crates.io/crates/unarc-cli) release for each
platform during the image build, pinned by `UNARC_VERSION` in `docker/Dockerfile`. The build then
runs `docker/check_tools.js`, which reads the default archivers and description tools and fails
if any program they call is missing, if `unrar` is not RARLAB's, or if `unarc` is not the pinned
version.

:::note
Files uploaded or imported while an image lacked one of these tools were stored as plain files,
with only a description made from their file name. A rescan re-describes them, taking a
`FILE_ID.DIZ` or similar from inside the archive, for example
`docker exec ENiGMABBS ./oputil.js fb scan --full --update AREA_TAG` (see [oputil](../admin/oputil.md)).
It does not change their recorded file type: they stay plain files in the database.
:::

## Volumes

Containers by their nature are ephermeral. Meaning, stuff you want to keep (config, database, mail) needs
to be stored outside of the running container. As such, the following volumes are mountable:

| Volume                  | Usage                                                                |
|:------------------------|:---------------------------------------------------------------------|
| /enigma-bbs/art         | Art, themes, etc                                                     |
| /enigma-bbs/config      | Config such as config.hjson, menu.hjson, prompt.hjson, SSL certs etc |
| /enigma-bbs/db          | ENiGMA databases                                                     |
| /enigma-bbs/filebase    | Filebase                                                             |
| /enigma-bbs/logs        | Logs                                                                 |
| /enigma-bbs/mods        | ENiGMA mods                                                          |
| /mail                   | FTN mail (for use with an external mailer)                           |


## Building your own image

Customising the Docker image is easy!

1. Clone the ENiGMA-BBS source.
2. Build the image
```bash
docker build -t enigmabbs -f ./docker/Dockerfile .
```

The Dockerfile has three stages. A `build` stage installs a compiler toolchain and runs
`npm ci`, which is where the native modules (node-pty, better-sqlite3 and friends) are
compiled. An `unarc` stage builds `unarc` with Rust; it runs on the machine doing the build
and cross compiles for each target platform, which takes a minute or two where building
under emulation would take far longer. The stage that ships installs only the runtime
packages -- the archivers, the description tools and `lrzsz` -- and copies `node_modules`
and the `unarc` binary out of the other two, so no compiler reaches the published image
([#814](https://github.com/NuSkooler/enigma-bbs/issues/814)). Because the compiled modules
are copied rather than rebuilt, the `build` stage and the one that ships must start from the
same base image; keep them in step if you change one.

`ENIGMA_DOCKER_LIVE=1 npm run test:live` builds the image and checks it from the inside:
that the toolchain is absent, the archivers, description tools and `sexyz` are present, and
the copied native modules load. Point `ENIGMA_DOCKER_IMAGE` at a tag to check an image you
already have.

3. Run the image
```bash
docker run -it -p 8888:8888 --name "ENiGMABBS" -v "$(pwd)/config:/enigma-bbs/config" -v "$(pwd)/db:/enigma-bbs/db" -v "$(pwd)/logs:/enigma-bbs/logs" -v "$(pwd)/filebase:/enigma-bbs/filebase" -v "$(pwd)/art:/enigma-bbs/art" -v "$(pwd)/mods:/enigma-bbs/mods" -v "$(pwd)/mail:/mail" enigmabbs
```
