---
layout: page
title: NNTP Server
---
## The NNTP Content Server
The NNTP *content server* provides access to publicly exposed message conferences and areas over either **secure** NNTPS (NNTP over TLS or nttps://) and/or non-secure NNTP (nntp://).

## Configuration
The following keys are available within the `contentServers.nntp` configuration block:


| Item | Required | Description |
|------|----------|-------------|
| `nntp` | :-1: | Configuration block for non-secure NNTP. See [Non-Secure NNTP Configuration](#non-secure-configuration). |
| `nntps` | :-1: | Configuration block for secure NNTP. See [Secure Configuration (NNTPS)](#secure-configuration-nntps) |
| `publicMessageConferences` | :+1: | A map of *conference tags* to *area tags* that are publicly exposed over NNTP. <u>Anonymous users will gain read-only access to these areas</u>. |
| `allowPosts` | :-1: | Allow posting from <u>authenticated users</u>. See [Write Access](#write-access). Default is `false`.

### Non-Secure Configuration
Under `contentServers.nntp.nntp` the following configuration is allowed:

| Item | Required | Description |
|------|----------|-------------|
| `enabled` | :+1: | Set to `true` to enable non-secure NNTP access. |
| `port` | :-1: | Override the default port of `8119`. |

### Secure Configuration (NNTPS)
Under `contentServers.nntp.nntps` the following configuration is allowed:

| Item | Required | Description |
|------|----------|-------------|
| `enabled` | :+1: | Set to `true` to enable secure NNTPS access. |
| `port` | :-1: | Override the default port of `8565`. |
| `certPem` | :-1: | Override the default certificate file path of `./config/nntps_cert.pem` |
| `keyPem` | :-1: | Override the default certificate key file path of `./config/nntps_key.pem` |

#### Certificates and Keys
In order to use secure NNTPS, a TLS certificate and key pair must be provided. You may generate your own but most clients **will not trust** them. A certificate and key from a trusted Certificate Authority is recommended. [Let's Encrypt](https://letsencrypt.org/) provides free TLS certificates. Certificates and private keys must be in [PEM format](https://en.wikipedia.org/wiki/Privacy-Enhanced_Mail).

##### Generating a Certificate & Key Pair
An example of generating your own cert/key pair:
```bash
openssl req -newkey rsa:2048 -nodes -keyout ./config/nntps_key.pem -x509 -days 3050 -out ./config/nntps_cert.pem
```

## Write Access
Authenticated users may write messages to a group given the following are true:

1. `allowPosts` is set to `true`
2. They are connected securely (NNTPS). This is a strict requirement due to how NNTP authenticates in plain-text otherwise.
3. The authenticated user has write [ACS](../../configuration/acs.md) to the target message conference and area.

> :warning: **Not all [ACS](../../configuration/acs.md) codes can be evaluated over NNTP.** NNTP sessions do not have a traditional BBS client connection — there is no terminal, no node number, and no theme. The ACS subject is constructed with `client: null` and only the authenticated user object. Any ACS code that depends on client properties will **fail closed** (return false, denying access). Affected codes include:
>
> | Code | Reason |
> |------|--------|
> | `LC` | No client to check for local connection |
> | `SC` | No client session to check for TLS (use NNTPS server-level config instead) |
> | `TH`, `TW` | No terminal dimensions |
> | `TT` | No terminal type |
> | `TM` | No theme |
> | `NN` | No node number |
> | `EC` | No terminal encoding |
>
> ACS codes that only depend on **user properties** work normally over NNTP: `GM`, `ID`, `NC`, `NP`, `AA`, `AF`, `AR`, `AC`, `AP`, `UP`, `DL`, `BU`, `BD`, `NR`, `KR`, `PC`, `PV`, `AG`, `AS`.
>
> This means if your message area ACS uses any client-dependent code, NNTP users will be denied access even if they are otherwise authorized. Design NNTP-exposed area ACS strings using only user-based codes.

## Example Configuration
```hjson
contentServers: {
    nntp: {
        allowPosts: true

        publicMessageConferences: {
            fsxnet: [
                // Expose these areas of fsxNet
                "fsx_gen", "fsx_bbs"
            ]
        }

        nntp: {
            enabled: true
        }

        nntps: {
            enabled: true

            // These could point to Let's Encrypt provided pairs for example:
            certPem: /path/to/some/tls_cert.pem
            keyPem: /path/to/some/tls_private_key.pem
        }
    }
}
```
