---
layout: page
title: Internet Mail (Email)
---
## Internet Mail

ENiGMA½ can send and receive internet email directly from the message system. Users compose private messages addressed to `user@domain.com` and they are delivered via your configured SMTP transport. Inbound email arrives by polling an IMAP mailbox; messages addressed to `username@yourdomain.com` are routed to the matching local user.

This feature is implemented as an `email` scanner/tosser module, following the same pattern as [FTN/BSO](bso-import-export.md) and ActivityPub.

> :information_source: Outbound email requires the `email.transport` block to be configured. See [Email Configuration](../configuration/email.md).

## Sending Email

Once outbound transport is configured, users can address a private message to any internet email address:

- `bob@example.com`
- `Alice Smith <alice@example.com>`

The system detects the email flavor automatically using the same address parser that handles FTN and ActivityPub addresses. The message is delivered via Nodemailer and marked exported in the message database.

If delivery fails (e.g. transport not configured, SMTP error), the message is marked `ExportFailed` and a warning is logged.

## Receiving Email (Inbound IMAP)

ENiGMA½ polls an IMAP mailbox at a configurable interval. When a new message arrives addressed to `username@yourdomain.com`, the username portion before `@` is matched against local BBS users. Matched messages are delivered to the user's private mail area.

Messages that cannot be matched to a local user are saved as `.eml` files in `mail/email/failed/` for sysop review.

> :bulb: Set up a dedicated mailbox (e.g. `bbs@yourdomain.com`) and configure your mail provider to accept `*@yourdomain.com` into it, or use per-user aliases — whatever fits your provider. ENiGMA½ only needs IMAP access to a single inbox.

## Configuration

All email configuration lives under the `email` block in `config.hjson`.

### Inbound Configuration Reference

| Key | Default | Description |
|-----|---------|-------------|
| `inbound.enabled` | `false` | Set to `true` to enable IMAP polling |
| `inbound.imap.host` | — | IMAP server hostname |
| `inbound.imap.port` | `993` | IMAP port |
| `inbound.imap.secure` | `true` | Use implicit TLS (port 993). Set `false` for STARTTLS on port 143 |
| `inbound.imap.user` | — | IMAP login username |
| `inbound.imap.password` | — | IMAP login password |
| `inbound.imap.pollIntervalMs` | `300000` | How often to check for new messages (ms). Set to `0` to use IMAP IDLE (push-like, persistent connection) |
| `inbound.imap.processedFolder` | *(none)* | IMAP folder to move processed messages into. If omitted, messages are only marked `\Seen` |
| `inbound.imap.maxMessagesPerRun` | `50` | Maximum messages to import per poll cycle |

### Polling vs. IMAP IDLE

| | Polling (`pollIntervalMs > 0`) | IDLE (`pollIntervalMs: 0`) |
|---|---|---|
| **Delivery latency** | Up to `pollIntervalMs` | Near-instant |
| **Connection** | Connect, fetch, disconnect | Persistent connection |
| **Complexity** | Simple, stateless | Requires stable network; auto-reconnects on drop |
| **Best for** | Most setups | Low-latency installs with stable connectivity |

For most BBS operators, the default 5-minute polling interval is more than sufficient.

## Example Configurations

### Minimal outbound-only setup

If you only want users to be able to *send* internet email:

```hjson
email: {
    defaultFrom: "Sysop <sysop@yourbbs.net>"

    transport: {
        host: smtp.yourdomain.com
        port: 587
        secure: false
        auth: {
            user: bbs@yourdomain.com
            pass: yourpassword
        }
    }
}
```

### Full send + receive setup

```hjson
email: {
    defaultFrom: "Sysop <sysop@yourbbs.net>"

    transport: {
        host: smtp.yourdomain.com
        port: 587
        secure: false
        auth: {
            user: bbs@yourdomain.com
            pass: yourpassword
        }
    }

    inbound: {
        enabled: true

        imap: {
            host: imap.yourdomain.com
            port: 993
            secure: true
            user: bbs@yourdomain.com
            password: yourpassword

            //  Check every 5 minutes (default)
            pollIntervalMs: 300000

            //  Move imported messages here on the IMAP server
            processedFolder: "BBS-Processed"
        }
    }
}
```

### Using IMAP IDLE (push-like)

```hjson
inbound: {
    enabled: true

    imap: {
        host: imap.yourdomain.com
        port: 993
        secure: true
        user: bbs@yourdomain.com
        password: yourpassword

        //  0 = use IMAP IDLE instead of polling
        pollIntervalMs: 0

        processedFolder: "BBS-Processed"
    }
}
```

### Using a service provider (Fastmail, ProtonMail Bridge, etc.)

Any provider that exposes standard IMAP/SMTP works. Example using Fastmail:

```hjson
email: {
    defaultFrom: "Sysop <bbs@yourdomain.com>"

    transport: {
        host: smtp.fastmail.com
        port: 587
        secure: false
        auth: {
            user: bbs@yourdomain.com
            pass: yourapppassword
        }
    }

    inbound: {
        enabled: true

        imap: {
            host: imap.fastmail.com
            port: 993
            secure: true
            user: bbs@yourdomain.com
            password: yourapppassword
            pollIntervalMs: 300000
            processedFolder: "BBS-Processed"
        }
    }
}
```

> :warning: Many providers (Gmail, Outlook) require an **app password** or OAuth2 token rather than your account password for IMAP/SMTP access. Generate one in your provider's security settings.

## Failed Message Handling

Messages that cannot be delivered to a local user (unknown username, parse error) are saved as raw `.eml` files in `mail/email/failed/`. The filename includes a timestamp and a short reason code (e.g. `1712345678901_no_user.eml`).

Sysops can inspect these files with any email client or text editor to diagnose routing issues.

## See Also

- [Email Configuration](../configuration/email.md) — SMTP transport setup
- [Message Networks](message-networks.md) — Overview of all supported networks
- [Configuring a Message Area](configuring-a-message-area.md) — Private mail area setup
