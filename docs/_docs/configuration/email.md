---
layout: page
title: Email
---
## Email Support

ENiGMA½ uses email for:

- **System notifications** — password resets, 2FA registration, account unlock flows.
- **Internet mail** — user-to-internet email send/receive via the [Internet Mail](../messageareas/internet-mail.md) scanner/tosser.

All email is powered by [Nodemailer](https://nodemailer.com/about/), which supports SMTP directly as well as many pre-defined service shortcuts (Zoho, Fastmail, Sendgrid, etc.). The `transport` block within `email` must be Nodemailer-compatible.

## Configuration Reference

All email configuration lives under the `email` block in `config.hjson`.

| Key | Default | Description |
|-----|---------|-------------|
| `defaultFrom` | — | Default `From:` header, e.g. `"Sysop <sysop@yourbbs.net>"`. Also used as `Sender:` and envelope `MAIL FROM` when per-user `From:` is active. |
| `transport` | — | Nodemailer transport options (SMTP host/port/auth, or a Nodemailer service shortcut). See examples below. |
| `outbound.fromDomain` | *(unset)* | If set, outbound mail is sent as `"UserName" <sanitized@fromDomain>` instead of `defaultFrom`. See [Internet Mail → Outbound Configuration](../messageareas/internet-mail.md#configuration) for details and the honesty headers (`Sender:`, envelope `MAIL FROM`) it sets alongside. |
| `outbound.usernameReplaceChar` | `_` | Replacement character for invalid local-part characters when deriving a local-part from a BBS username (e.g. spaces). |
| `inbound` | *(disabled)* | Inbound IMAP polling configuration. See [Internet Mail → Inbound Configuration](../messageareas/internet-mail.md#inbound-configuration-reference). |

> :information_source: Only `defaultFrom` and `transport` are required for system notifications (password reset, etc.). Everything under `outbound` and `inbound` is opt-in for internet-mail send/receive.

## Services

If you don't have an SMTP server to send from, [Sendgrid](https://sendgrid.com/), [Zoho](https://www.zoho.com/mail/), [Fastmail](https://www.fastmail.com/), [Purelymail](https://purelymail.com/), and similar providers all work out of the box — both for outbound SMTP and inbound IMAP.

## Example Configurations

### Example 1 — System notifications only (SMTP)

Just enough to send password-reset emails from the sysop address:

```hjson
email: {
    defaultFrom: "Sysop <sysop@bbs.awesome.com>"

    transport: {
        host: smtp.awesomeserver.com
        port: 587
        secure: false
        auth: {
            user: leisuresuitlarry
            pass: sierra123
        }
    }
}
```

### Example 2 — Nodemailer service shortcut (Zoho)

```hjson
email: {
    defaultFrom: "Sysop <sysop@bbs.awesome.com>"

    transport: {
        service: Zoho
        auth: {
            user: noreply@bbs.awesome.com
            pass: yuspymypass
        }
    }
}
```

### Example 3 — Full internet-mail setup (per-user `From:` + inbound IMAP)

```hjson
email: {
    defaultFrom: "ENiGMA½ BBS <noreply@yourbbs.net>"

    transport: {
        host: smtp.yourdomain.com
        port: 587
        requireTLS: true
        auth: {
            user: noreply@yourbbs.net
            pass: yourpassword
        }
    }

    //  Send as "<UserName>" <username@yourbbs.net> instead of defaultFrom.
    //  Requires your SMTP provider to allow the authenticated account to
    //  send as other local-parts within the domain.
    outbound: {
        fromDomain: yourbbs.net
    }

    //  Poll a shared IMAP mailbox and route mail to local users by
    //  To: local-part (usually needs a catch-all rule at your provider).
    inbound: {
        enabled: true

        imap: {
            host: imap.yourdomain.com
            port: 993
            secure: true
            user: noreply@yourbbs.net
            password: yourpassword
            pollIntervalMs: 300000
            processedFolder: "BBS-Processed"
            failedFolder: "BBS-Failed"
        }
    }
}
```

See [Internet Mail](../messageareas/internet-mail.md) for the full reference, inbound flow details, failed-message handling, and provider-specific tips (app passwords, catch-all rules, etc.).

## Password Reset / Account Unlock

If email is configured and you allow email-driven password resets, you may also allow locked accounts to be unlocked at reset time. This is controlled by `users.unlockAtEmailPwReset`. If an account is locked due to too many failed login attempts, the user can reset their password to remedy the situation themselves.

## See Also

- [Internet Mail](../messageareas/internet-mail.md) — full send/receive setup, inbound routing, per-user `From:` behavior
- [Message Networks](../messageareas/message-networks.md) — overview of all supported networks
