# Introduction
ENiGMA½ is a modern from scratch BBS package written in Node.js.

# Quickstart
TL;DR? This should get you started...

1\. Clone
```bash
git clone https://github.com/NuSkooler/enigma-bbs.git
```

2\. Install dependencies
```bash
npm install
```

3\. Generate a SSH Private Key
Note that you can skip this step and disable the SSH server in your `config.hjson` if desired.

```bash
openssl genrsa -des3 -out ./misc/ssh_private_key.pem 2048
```

4\. Create a minimal config
Main system configuration is handled via `~/.config/enigma-bbs/config.hjson`. This is a HJSON file (compiliant JSON is also OK).

```hjson
general: {
  boardName: Super Awesome BBS
}
servers: {
  ssh: {
    privateKeyPass: YOUR_PK_PASS
}
messages: {
  areas: [
    { name: "local_enigma_discusssion", desc: "ENiGMA Discussion", groups: [ "users" ] }
  ]
}
```

5\. Launch!
```bash
./main.js
```

The first user you create via applying is the root SysOp.