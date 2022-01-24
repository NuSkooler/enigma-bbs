---
layout: page
title: Docker
---
**You'll need Docker installed before going any further. How to do so are out of scope of these docs, but you can find full instructions
for every operating system on the [Docker website](https://docs.docker.com/engine/install/).**

## Quick Start

- Generate some config for your BBS:
  ```
  docker run -it -v "${HOME}/enigma-bbs/config:/enigma-bbs/config" enigmabbs/enigma-bbs:latest oputil.js config new
  ```

- Run it:
  ```
  docker run -p 8888:8888 -v "${HOME}/enigma-bbs/config:/enigma-bbs/config" enigmabbs/enigma-bbs:latest
  ```

:bulb: Configuration will be stored in `${HOME}/enigma-bbs/config`.

:bulb: Windows users - you'll need to switch out `${HOME}/enigma-bbs/config` for a Windows-style path.

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

   ```
   docker build -f ./docker/Dockerfile .
   ```
