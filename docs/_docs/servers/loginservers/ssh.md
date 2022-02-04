---
layout: page
title: SSH Server
---
## SSH Login Server
The ENiGMA½ SSH *login server* allows secure user logins over SSH (ssh://).

## Configuration
Entries available under `config.loginServers.ssh`:

| Item | Required | Description |
|------|----------|-------------|
| `privateKeyPem` | :-1: | Path to private key file. If not set, defaults to `./config/ssh_private_key.pem` |
| `privateKeyPass` | :+1: | Password to private key file.
| `firstMenu` | :-1: | First menu an SSH connected user is presented with. Defaults to `sshConnected`. |
| `firstMenuNewUser` | :-1: | Menu presented to user when logging in with one of the usernames found within `users.newUserNames` in your `config.hjson`. Examples include `new` and `apply`. |
| `enabled` | :+1: | Set to `true` to enable the SSH server. |
| `port` | :-1: | Override the default port of `8443`. |
| `address` | :-1: | Sets an explicit bind address. |
| `algorithms` | :-1: | Configuration block for SSH algorithms. Includes keys of `kex`, `cipher`, `hmac`, and `compress`. See the algorithms section in the [ssh2-streams](https://github.com/mscdex/ssh2-streams#ssh2stream-methods) documentation for details. For defaults set by ENiGMA½, see `core/config_default.js`.
| `traceConnections` | :-1: | Set to `true` to enable full trace-level information on SSH connections.

### Example Configuration

```hjson
{
    loginServers: {
        ssh: {
            enabled: true
            port: 8889
            privateKeyPem: /path/to/ssh_private_key.pem
            privateKeyPass: sup3rs3kr3tpa55
        }
    }
}
```

## Generate a SSH Private Key
To utilize the SSH server, an SSH Private Key (PK) will need generated. OpenSSL can be used for this task:

### Modern OpenSSL
```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -pkeyopt rsa_keygen_pubexp:65537 | openssl rsa -out ./config/ssh_private_key.pem -aes128
```

### Legacy OpenSSL
```bash
openssl genrsa -aes128 -out ./config/ssh_private_key.pem 2048
```

Note that you may need `-3des` for every old implementations or SSH clients!

