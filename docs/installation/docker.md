---
layout: page
title: Docker
---
**You'll need Docker installed before going any further. How to do so are out of scope of these docs, but you can find full instructions
for every operating system on the [Docker website](https://docs.docker.com/engine/install/).**

## Quick Start
prepare a folder where you are going to save your bbs files.
- Generate some config for your BBS: \
you can perform this step from anywhere - but make sure to consistently run it from the same place to retain your config inside the docker guest
```
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
- Run it: \
you can use the same command as above, just daemonize and drop interactiveness (we needed it for config but most of the time docker will run in the background)
````
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
````
- Restarting and Making changes\
if you make any changes to your host config folder they will persist, and you can just restart ENiGMABBS container to load any changes you've made.

```docker restart ENiGMABBS```

:bulb: Configuration will be stored in `$(pwd)/enigma-bbs/config`.

:bulb: Windows users - you'll need to switch out `$(pwd)/enigma-bbs/config` for a Windows-style path.

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
