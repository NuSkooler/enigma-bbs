---
layout: page
title: SSH Server
---
## Generate a SSH Private Key

To utilize the SSH server, an SSH Private Key will need generated. From the ENiGMA installation directory:

```bash
openssl genrsa -des3 -out ./config/ssh_private_key.pem 2048
```

You then need to enable the SSH server in your `config.hjson`:

```hjson
{
	loginServers: {
		ssh: {
            enabled: true
		    port: 8889
		    privateKeyPem: /path/to/ssh_private_key.pem
            privateKeyPass: YOUR_PK_PASS
        }                                                             
    }
}
```

### SSH Server Options

| Option              | Description
|---------------------|--------------------------------------------------------------------------------------|
| `privateKeyPem`	  | Path to private key file.
| `privateKeyPass`    | Password to private key file.
| `firstMenu`		  | First menu an SSH connected user is presented with.
| `firstMenuNewUser`  | Menu presented to user when logging in with `users::newUserNames` in your config.hjson (defaults to `new` and `apply`).
| `enabled`           | Enable/disable SSH server.
| `port`              | Configure a custom port for the SSH server.
| `algorithms`        | Configuration block for SSH algoritms. Includes arrays with keys of `kex`, `cipher`, `hmac`, and `compress`. See the algorithms section in the [ssh2-streams](https://github.com/mscdex/ssh2-streams#ssh2stream-methods) documentation for details. For defaults set by ENiGMA½, see `core/config.js`.
| `traceConnections`  | Set to `true` to enable full trace-level information on SSH connections.
