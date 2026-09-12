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
3. Run the image
```bash
docker run -it -p 8888:8888 --name "ENiGMABBS" -v "$(pwd)/config:/enigma-bbs/config" -v "$(pwd)/db:/enigma-bbs/db" -v "$(pwd)/logs:/enigma-bbs/logs" -v "$(pwd)/filebase:/enigma-bbs/filebase" -v "$(pwd)/art:/enigma-bbs/art" -v "$(pwd)/mods:/enigma-bbs/mods" -v "$(pwd)/mail:/mail" enigmabbs
```
