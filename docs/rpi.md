# Raspberry Pi

ENiGMA½ can run under your Linux / RPi installation! The following instructions should help get you started.

## Tested RPi Models
### Model A
Works, but fairly slow when browsing message areas (Node itself is not the fastest on this device). May work better overlocked, etc.

### v2 Model B
Works well with Raspbian!

Keep in mind, compiling the dependencies with `npm install` will take some time and appear to hang. Just be patient.

## Example Configuration: RPi Model A + Raspbian Stretch Lite

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

5. Follow the [Quickstart](docs/index.md) instructions to install ENiGMA½.

6. Profit!
