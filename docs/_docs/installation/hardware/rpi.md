---
layout: page
title: Raspberry Pi
---

All Raspberry Pi models work great with ENiGMA½! Keep in mind compiling the dependencies with
`npm install` will take some time and *may* appear to hang. It's still working - just be patient and let it
complete.

### Basic Instructions

1. Download [Raspbian Stretch Lite](https://www.raspberrypi.org/downloads/raspbian/). Follow the instructions
on the [Raspbian site](https://www.raspberrypi.org/documentation/installation/installing-images/README.md) regarding how
to get it written to an SD card.

2. Run `sudo raspi-config`, then:
    1. Set your timezone (option 4, option I2)
    2. Enable SSH (option 5, option P2)
    3. Expand the filesystem to use the entire SD card (option 7, option A1)

3. Update & upgrade all packages: `apt-get update && apt-get upgrade`

4. Install required packages: `sudo apt install lrzsz p7zip-full`

5. Follow the [installation instructions](../installation/) to install ENiGMA½.

6. Profit!
