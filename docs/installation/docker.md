---
layout: page
title: Docker
---
**You'll need Docker installed before going any further. How to do so are out of scope of these docs, but you can find full instructions
for every operating system on the [Docker website](https://docs.docker.com/engine/installation/).**

## Quick Start
Download and run the ENiGMA½ BBS image:

    docker run -d \
      -p 8888:8888 \
      davestephens/enigma-bbs:latest

:information_source: This is a **very basic** example! As no config has been supplied the container will use a basic one so that it starts successfully. Note that as no persistence directory has been supplied, once the container stops any changes made will be lost!

:information_source: [Volumes](https://docs.docker.com/storage/volumes/) may be used for things such as your configuration and database path.

## Customized Docker Setup
TBC using Docker Compose

:pencil: This area is looking for contributors!
