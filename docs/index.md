# Introduction
ENiGMA½ is a modern from scratch BBS package written in Node.js.

# Quickstart
TL;DR? This should get you started...

## Prerequisites
* Node.js version **v0.12.2 or higher** (v4.2+ is recommended). io.js should also work, though I have not yet tested this.
* Windows users will need additional dependencies installed for the `npm install` step in order to compile native binaries:
  * A recent copy of Visual Studio (Express editions OK)
  * Python 2.7.x
  
## Clone
```bash
git clone https://github.com/NuSkooler/enigma-bbs.git
```

## Install Node Modules
```bash
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

Some points of interest:
* Default ports are 8888 (Telnet) and 8889 (SSH)
* The first user you create via applying is the SysOp (aka root)
* You may want to tail the logfile with Bunyan: `tail -F ./logs/enigma-bbs.log | ./node_modules/bunyan/bin/bunyan`