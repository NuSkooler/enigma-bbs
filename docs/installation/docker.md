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

As no config has been supplied the container will use a basic one so that it starts successfully. Note that as no persistence 
directory has been supplied, once the container stops any changes made will be lost!

## Customised Docker Setup

TBC using Docker Compose
