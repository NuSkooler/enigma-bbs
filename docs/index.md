# Introduction
ENiGMA½ is a modern from scratch BBS package written in Node.js.

# Quickstart
TL;DR? This should get you started...

## Prerequisites
* [Node.js](https://nodejs.org/) version **v0.12.2 or higher** (v4.2+ is recommended)
  * [io.js](https://iojs.org/) should also work, though I have not yet tested this.
  * :information_source: It is suggested to use [nvm](https://github.com/creationix/nvm) to manage your Node/io.js installs
* **Windows users will need additional dependencies installed** for the `npm install` step in order to compile native binaries:
  * A recent copy of Visual Studio ([Visual Studio Express](https://www.visualstudio.com/en-us/products/visual-studio-express-vs.aspx) editions OK)
  * [Python](https://www.python.org/downloads/) 2.7.x
 
## New to Node
If you're new to Node.js and/or do not care about Node itself and just want to get ENiGMA½ running these steps should get you going on most \*nix type enviornments:

```bash
curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.30.1/install.sh | bash
nvm install 4.2.4
nvm use 4.2.4
```


If the above completed without errors, you should now have `nvm`, `node`, and `npm` installed and in your environment.
  
## Clone
```bash
git clone https://github.com/NuSkooler/enigma-bbs.git
```

## Install Node Modules
```bash
cd enigma-bbs
npm install
```

## Generate a SSH Private Key
To utilize the SSH server, a SSH Private Key will need generated. This step can be skipped if desired by disabling the SSH server in `config.hjson`.
```bash
openssl genrsa -des3 -out ./misc/ssh_private_key.pem 2048
```

## Create a Minimal Config
The main system configuration is handled via `~/.config/enigma-bbs/config.hjson`. This is a [HJSON](http://hjson.org/) file (compiliant JSON is also OK). See [Configuration](config.md) for more information.

```hjson
general: {
  boardName: Super Awesome BBS
}
servers: {
  ssh: {
    privateKeyPass: YOUR_PK_PASS
    enabled: true /* set to false to disable the SSH server */
  }
}
messages: {
  areas: [
    { name: "local_enigma_discusssion", desc: "ENiGMA Discussion", groups: [ "users" ] }
  ]
}
```

## Launch!
```bash
./main.js
```

ENiGMA½ does not produce much to standard out. See below for tailing the log file to see what's going on.

### Points of Interest
* Default ports are 8888 (Telnet) and 8889 (SSH)
  * Note that on *nix systems port such as telnet/23 are privileged (e.g. require root). See [this SO article](http://stackoverflow.com/questions/16573668/best-practices-when-running-node-js-with-port-80-ubuntu-linode) for some tips on using these ports on your system if desired.
* The first user you create via applying is the SysOp (aka root)
* You may want to tail the logfile with Bunyan: `tail -F ./logs/enigma-bbs.log | ./node_modules/bunyan/bin/bunyan`

# Advanced Installation
If you've become convinced you would like a "production" BBS running ENiGMA½ a more advanced installation may be in order. 

[PM2](https://github.com/Unitech/pm2) is an excellent choice for managing your running ENiGMA½ instances. Additionally, it is suggested that you run as a specific more locked down user (e.g. 'enigma').
