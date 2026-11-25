---
title: SSH Server
description: "The SSH login server: generating a host key, algorithms, and public key authentication."
sidebar:
    order: 2
---
## SSH Login Server

The ENiGMA½ SSH *login server* allows secure user logins over SSH (ssh://).

*Note:* If you run into any troubles during SSH setup, please see [Troubleshooting SSH](../../troubleshooting/ssh-troubleshooting.md)

## Configuration

Entries available under `config.loginServers.ssh`:

| Item | Required | Description |
|------|----------|-------------|
| `privateKeyPem` | No | Path to private key file. If not set, defaults to `./config/ssh_private_key.pem` |
| `privateKeyPass` | Yes | Password to private key file. *
| `firstMenu` | No | First menu an SSH connected user is presented with. Defaults to `sshConnected`. |
| `firstMenuNewUser` | No | Menu presented to user when logging in with one of the usernames found within `users.newUserNames` in your `config.hjson`. Examples include `new` and `apply`.|
| `enabled` | Yes | Set to `true` to enable the SSH server. |
| `port` | No | Override the default port of `8889`. |
| `address` | No | Sets an explicit bind address. |
| `algorithms` | No | Configuration block for SSH algorithms. Includes keys of `kex`, `cipher`, `hmac`, and `compress`. See the algorithms section in the [ssh2-streams](https://github.com/mscdex/ssh2-streams#ssh2stream-methods) documentation for details. For defaults set by ENiGMA½, see `core/config_default.js`.
| `traceConnections` | No | Set to `true` to enable full trace-level information on SSH connections.
| `loginTimeoutSeconds` | No | How long, in seconds, a connection may take from connecting to reaching the shell before it is disconnected. Defaults to `120`, the same as OpenSSH's `LoginGraceTime`. `0` turns the limit off; the most it can be is `2147483` (about 24.8 days, the longest timer Node can run). See [Login Timeout](#login-timeout).
| `untrustedTermSizeClients` | No | List of SSH client identification strings whose reported terminal size should be skipped, compared in full and case-insensitively. Defaults to `[ "SSH-2.0-cryptlib" ]`, which covers NetRunner: stock cryptlib hardcodes the terminal size as 80x48 and gives the application no way to change it. The size is established by querying the terminal instead, falling back to the usual 80x25 assumption if that query fails. Matching is deliberately exact rather than by substring: SyncTERM reports the actual size but identifies as `SSH-2.0-cryptlib(SBBS)` on 1.9rc4 and `SSH-2.0-SyncTERM_<version>` on newer builds, so a loose match on `cryptlib` would wrongly catch it. Remove an entry if a client's size reporting is fixed upstream.

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

:::tip
To avoid storing the passphrase in plain text, use the `@file:` directive to read it from a separate file — for example a Docker/Podman secret or a chmod-600 file:
```hjson
privateKeyPass: "@file:/run/secrets/ssh_key_pass"
```
See [Configuration Files — Secret Files](../../configuration/config-files.md#secret-files) for details.
:::

### Login Timeout

An SSH connection takes a node (it counts against `general.maxConnections`) as soon as it connects, before the caller has logged in. The idle timeout starts only once the caller reaches the shell, and SSH keepalives are off because some BBS terminals do not answer them. A connection that stops part way, during key exchange or at the password prompt, would otherwise keep its node until the caller closed it.

So a connection that has not reached the shell within `loginTimeoutSeconds` (120 by default) is disconnected, its socket closed outright 2 seconds later if the caller has not closed it, and its node freed. The time covers key exchange, authentication (password typing and retries included) and opening the shell. A caller who has reached the shell is not affected; from there the usual idle timeout applies. It is logged at `info` level ("SSH connection did not reach a shell in time; ending it").

```hjson
loginServers: {
    ssh: {
        //  give callers 3 minutes to log in
        loginTimeoutSeconds: 180
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

## Refused Logins

A caller whose login is refused because of the account (already connected on another node, disabled, waiting for activation, or locked) is told why at the login stage, then disconnected: the reason is shown through keyboard-interactive with no prompt, as for a full board (see [Limiting Connections](../index.md#limiting-connections)), and needs no key press. A caller who logged in with a password or public key is sent to keyboard-interactive to see it; a client that does not do keyboard-interactive gets an authentication failure. A locked account's answer comes after 2 seconds, as a wrong password's does. A public key query (a client asking whether a key would do, before it signs with it) is answered from the key alone and says nothing about the account.

## Busy Message

The message a caller sees when every node is busy, *All nodes are busy. Try again later...* by default, can be replaced with an optional `BUSY.ASC` art file, shared by all login servers. There is no user yet when a caller is turned away, so it is looked for in the pre-login theme (`theme.preLogin`, when it names one available theme; not when it is `*`, a random pick), then the default theme (`theme.default`), then `art/general`. It is read in the background, at most once a minute while callers come in, so a new or changed file is used within about a minute.

The file reaches every caller who is turned away, before their terminal type is known: telnet and WebSocket callers get it as written, with pipe colour codes rendered (MCI codes are not: there is no session yet to fill them in), so ANSI sequences and pipe codes in it reach PETSCII and ATASCII callers too. Plain text is the safe choice. Over SSH it is always shown as plain text: OpenSSH shows control characters as escapes, so ANSI sequences, pipe codes, other control characters and Unicode formatting characters (bidi controls, zero width characters) are removed. The whole file is one message there, so keep it short.

## SSH Public Key Authentication

Users can now authenticate with SSH public keys in addition to passwords. Each account may store a single OpenSSH-format public key (for example, `ssh-ed25519 AAAA... comment`).

1. Log in through an already secure transport (SSH or secure WebSocket) and enter the `SSH` command from the main menu.
2. Paste the OpenSSH public key into the form and choose **save/update key**. The system records the key along with its SHA-256 fingerprint.
3. Optional: use **remove key** to clear the stored key and fall back to password logins.

Once saved, ENiGMA½ will require clients connecting with the `publickey` SSH method to prove possession of the corresponding private key. The upload menu is blocked on insecure transports to prevent man-in-the-middle attacks that could replace a user's public key.
