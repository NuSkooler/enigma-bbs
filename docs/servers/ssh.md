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
            privateKeyPass: YOUR_PK_PASS
        }                                                                                                                                                                                                   
    }
}
```

### SSH Server Options

| Option              | Description
|---------------------|--------------------------------------------------------------------------------------|
| `privateKeyPem`	  | Path to private key file
| `privateKeyPass`    | Password to private key file
| `firstMenu`		  | First menu an SSH connected user is presented with
| `firstMenuNewUser`  | Menu presented to user when logging in with `users::newUserNames` in your config.hjson (defaults to `new` and `apply`)
| `enabled`           | Enable/disable SSH server
| `port`              | Configure a custom port for the SSH server
