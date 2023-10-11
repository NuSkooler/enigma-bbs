---
layout: page
title: SSH Server
---
## SSH Login Server

The ENiGMA½ SSH *login server* allows secure user logins over SSH (ssh://).

*Note:* If you run into any troubles during SSH setup, please see [Troubleshooting SSH](../../troubleshooting/ssh-troubleshooting.md)

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

### OpenSSH (Preferred)

#### OpenSSH Install - Linux / Mac

If it is not already available, install OpenSSH using the package manager of your choice (should be pre-installed on most distributions.)

#### Running OpenSSH - Linux / Mac

From the root directory of the Enigma BBS, run the following:

```shell
mkdir -p config/security
ssh-keygen -t rsa -m PEM -h -f config/security/ssh_private_key.pem
```

#### Windows Install - OpenSSH

OpenSSH may already be installed, try running `ssh-keygen.exe`. If not, see this page: [Install OpenSSH for Windows](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse?tabs=gui)

#### Running OpenSSH - Windows

After installation, go to the root directory of your enigma project and run:

```powershell
mkdir .\config\security -ErrorAction SilentlyContinue
ssh-keygen.exe -t rsa -m PEM -h -f .\config\security\ssh_private_key.pem
```

#### ssh-keygen options

Option descriptions:

| Option | Description |
|------|-------------|
| `-t rsa` | Use the RSA algorithm needed for the `ssh2` library |
| `-m PEM` | Set the output format to `PEM`, compatible with the `ssh2` library |
| `-h` | Generate a host key |
| `-f config/ssh_private_key.pem` | Filename for the private key. Used in the `privateKeyPem` option in the configuration |

When you execute the `ssh-keygen` command it will ask for a passphrase (and a confirmation.) This should then be used as the value for `privateKeyPass` in the configuration.

### OpenSSL

#### Open SSL Install - Linux / Mac

If not already installed, install via the `openssl` package on most package managers.

#### Open SSL Install - Windows

```powershell
winget install -e --id ShiningLight.OpenSSL
```

#### Running OpenSSL

*Note:* Using `ssh-keygen` from OpenSSL is recommended where possible. If you have trouble with the above OpenSSH commands, using some versions for OpenSSL (before version 3) the following commands may work as well:

#### Running OpenSSL - Linux / Mac

Run the following from the root directory of Enigma

```shell
mkdir -p config/security
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -pkeyopt rsa_keygen_pubexp:65537 | openssl rsa -out ./config/security/ssh_private_key.pem -aes128
```

#### Running OpenSSL - Windows

Run the following from the root directory of Enigma (note: you may need to specify the full path to openssl.exe if it isn't in your system path, on my system it was `C:\Program Files\OpenSSL-Win64\bin\openssl.exe`):

```powershell
mkdir .\config\security -ErrorAction SilentlyContinue
openssl.exe genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -pkeyopt rsa_keygen_pubexp:65537 | openssl.exe rsa -out ./config/security/ssh_private_key.pem -aes128
```

#### Running Older OpenSSL

For older OpenSSL versions, the following command has been known to work:

```shell
openssl genrsa -aes128 -out ./config/ssh_private_key.pem 2048
```

*Note:* that you may need `-3des` for very old implementations or SSH clients!

## Prompt

The keyboard interactive prompt can be customized using a `SSHPMPT.ASC` art file. See [art](../../art/general.md) for more information on configuring. This prompt includes a `newUserNames` variable to show the list of allowed new user names (see `firstMenuNewUser` above.) See [mci](../../art/mci.md) for information about formatting this string. Note: Regardless of the content of the `SSHPMPT.ASC` file, the prompt is surrounded by "Access denied", a newline, the prompt, another newline, and then the string "\[username]'s password: ". This normally occurs after the first password prompt (no art is shown before the first password attempt is made.)