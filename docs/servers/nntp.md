---
layout: page
title: NNTP Server
---
## The NNTP Content Server
The NNTP *content server* provides access to publicly exposed message conferences and areas over either **secure** NNTPS (NNTP over TLS or nttps://) and/or non-secure NNTP (nntp://).

## Configuration

| Item | Required | Description |
|------|----------|-------------|
| `nntp` | :-1: | Configuration block for non-secure NNTP. See Non-Secure NNTP Configuration below. |
| `nntps` | :-1: | Configuration block for secure NNTP. See Secure NNTPS Configuration below. |
| `publicMessageConferences` | :+1: | A map of *conference tags* to *area tags* that are publicly exposed over NNTP. Anonymous users will get read-only access to these areas. |

### See Non-Secure NNTP Configuration
Under `contentServers.nntp.nntp` the following configuration is allowed:

| Item | Required | Description |
|------|----------|-------------|
| `enabled` | :+1: | Set to `true` to enable non-secure NNTP access. |
| `port` | :-1: | Override the default port of `8119`. |

### Secure NNTPS Configuration
Under `contentServers.nntp.nntps` the following configuration is allowed:

| Item | Required | Description |
|------|----------|-------------|
| `enabled` | :+1: | Set to `true` to enable secure NNTPS access. |
| `port` | :-1: | Override the default port of `8565`. |
| `certPem` | :-1: | Override the default certificate file path of `./config/nntps_cert.pem` |
| `keyPem` | :-1: | Override the default certificate key file path of `./config/nntps_key.pem` |

#### Certificates and Keys
In order to use secure NNTPS, a TLS certificate and key pair must be provided. You may generate your own but most clients **will not trust** them. A certificate and key from a trusted Certificate Authority is recommended. [Let's Encrypt](https://letsencrypt.org/) provides free TLS certificates. Certificates and private keys must be in [PEM format](https://en.wikipedia.org/wiki/Privacy-Enhanced_Mail).

##### Generating Your Own
An example of generating your own cert/key pair:
```bash
openssl req -newkey rsa:2048 -nodes -keyout ./config/nntps_key.pem -x509 -days 3050 -out ./config/nntps_cert.pem
```

### Example Configuration
```hjson
contentServers: {
    nntp: {
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
