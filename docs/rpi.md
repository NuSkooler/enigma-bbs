# Raspberry Pi

ENiGMA½ can run under your Linux / RPi installation! The following instructions should help get you started.

## Tested RPi Models
###Model A
Works, but fairly slow (Node itself is not the fastest on this device). May work better overlocked, etc.

###v2 Model B
Works well with default rasbian, follow the normal quickstart install procedure, except for installing nodejs. To install nodejs do the following: 
    
    curl -sL https://deb.nodesource.com/setup_4.x | sudo -E bash -
    sudo apt-get install -y nodejs

Keep in mind, compiling the dependencies with `npm install` will take some time and appear to hang. Just be patient.

##Example Configuration: RPi Model A + Minibian

### Basic Instructions

1. Download and `dd` the Minibian .img file from https://minibianpi.wordpress.com/ to a SDCARD. Cards >= 16GB recommended.
2. After booting Minibian, expand your file system. See http://elinux.org/RPi_Resize_Flash_Partitions#Manually_resizing_the_SD_card_on_Raspberry_Pi for information.
3. Update & upgrade: `apt-get update && apt-get upgrade`
4. It is recommended that you install `sudo` and create an admin user: `apt-get install sudo`, `adduser <yourname>`, `adduser <yourname> sudo` (reboot & login as the user your just created)
5. We want to build dependencies with a updated version of GCC. The following works to install GCC 4.9 on Minibian "wheezy":
a. Update */etc/apt/sources.list* replacing all "wheezy" with "jessie"
b. `sudo apt-get update`
c. `sudo apt-get install gcc-4.9 g++-4.9`
d. Update */etc/apt/sources.list* reverting all "jessie" back to "wheezy"
e. `sudo apt-get update`
f. Update alternatives: `sudo update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-4.9 60 --slave /usr/bin/g++ g++ /usr/bin/g++-4.9`
6. Install dependencies: `sudo apt-get install make python libicu-dev libssl-dev git`
7. Install the latest Node.js from here: http://node-arm.herokuapp.com/ (**only download the .dep and dpkg install it!**)
8. The RPi A has very low memory, we'll need a swap file: 
a. `sudo dd if=/dev/zero of=tmpswap bs=1024 count=1M`
b. `sudo mkswap tmpswap`
c. `sudo swapon tmpswap`
9. Clone enigma-bbs.git
10. Install dependencies. Here we will force GCC 4.9 for compilation: `CC=gcc-4.9 npm install`
11. Follow generic setup for creating a config.hjson, etc. and you should be ready to go!

