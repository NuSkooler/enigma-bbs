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
| `privateKeyPass` | :+1: | Password to private key file. *
| `firstMenu` | :-1: | First menu an SSH connected user is presented with. Defaults to `sshConnected`. |
| `firstMenuNewUser` | :-1: | Menu presented to user when logging in with one of the usernames found within `users.newUserNames` in your `config.hjson`. Examples include `new` and `apply`.|
| `enabled` | :+1: | Set to `true` to enable the SSH server. |
| `port` | :-1: | Override the default port of `8443`. |
| `address` | :-1: | Sets an explicit bind address. |
| `algorithms` | :-1: | Configuration block for SSH algorithms. Includes keys of `kex`, `cipher`, `hmac`, and `compress`. See the algorithms section in the [ssh2-streams](https://github.com/mscdex/ssh2-streams#ssh2stream-methods) documentation for details. For defaults set by ENiGMA½, see `core/config_default.js`.
| `traceConnections` | :-1: | Set to `true` to enable full trace-level information on SSH connections.


* *IMPORTANT* With the `privateKeyPass` option set, make sure that you verify that the config file is not readable by other users!


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
To utilize the SSH server, an SSH Private Key (PK) will need generated. OpenSSH or (with some versions) OpenSSL can be used for this task:

### OpenSSH

```bash
ssh-keygen -m PEM -h -f config/ssh_private_key.pem
```

Option descriptions:

| Option | Description |
|------|-------------|
| `-m PEM` | Set the output format to `PEM`, compatible with the `ssh2` library |
| `-h` | Generate a host key |
| `-f config/ssh_private_key.pem` | Filename for the private key. Used in the `privateKeyPem` option in the configuration |

When you execute the `ssh-keygen` command it will ask for a passphrase (and a confirmation.) This should then be used as the value for `privateKeyPass` in the configuration.


### OpenSSL

If you do not have OpenSSH installed or if you have trouble with the above OpenSSH commands, using some versions for OpenSSL (before version 3) the following commands may work as well:


```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -pkeyopt rsa_keygen_pubexp:65537 | openssl rsa -out ./config/ssh_private_key.pem -aes128
```

Or for even older OpenSSL versions:

```bash
openssl genrsa -aes128 -out ./config/ssh_private_key.pem 2048
```

Note that you may need `-3des` for very old implementations or SSH clients!


## Prompt

The keyboard interactive prompt can be customized using a `SSHPMPT.ASC` art file. See [art](../../art/general.md) for more information on configuring. This prompt includes a `newUserNames` variable to show the list of allowed new user names (see `firstMenuNewUser` above.) See [mci](../../art/mci.md) for information about formatting this string. Note: Regardless of the content of the `SSHPMPT.ASC` file, the prompt is surrounded by "Access denied", a newline, the prompt, another newline, and then the string "\[username]'s password: ". This normally occurs after the first password prompt (no art is shown before the first password attempt is made.)
