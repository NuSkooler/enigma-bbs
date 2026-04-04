---
layout: page
title: Raspberry Pi
---

All Raspberry Pi models work great with ENiGMA½! Keep in mind compiling the dependencies with
`npm install` will take some time and *may* appear to hang. It's still working - just be patient and let it
complete.

### Basic Instructions

1. Download [Raspberry Pi OS Lite](https://www.raspberrypi.com/software/operating-systems/) (64-bit recommended for Pi 3 and newer). Follow the instructions on the [Raspberry Pi site](https://www.raspberrypi.com/documentation/computers/getting-started.html) regarding how to get it written to an SD card.

2. Run `sudo raspi-config`, then:
    1. Set your timezone (option 5, option L2)
    2. Enable SSH (option 3, option P2)
    3. Expand the filesystem to use the entire SD card (option 6, option A1)

3. Update & upgrade all packages: `sudo apt-get update && sudo apt-get upgrade`

4. Install required packages: `sudo apt install git lrzsz p7zip-full`

5. Follow the [installation instructions](../install-script.md) to install ENiGMA½.

6. Profit!
