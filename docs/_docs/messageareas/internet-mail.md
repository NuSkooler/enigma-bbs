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

### Outbound Configuration Reference

| Key | Default | Description |
|-----|---------|-------------|
| `outbound.fromDomain` | *(unset)* | When set, outbound mail is sent as `"UserName" <sanitized@fromDomain>` where the local-part is derived from the BBS user's name. When unset, all outbound mail uses `defaultFrom`. |
| `outbound.usernameReplaceChar` | `_` | Character used to replace invalid characters when deriving the local-part from a BBS username (e.g. spaces → `_`). |

When `outbound.fromDomain` is set, the `From:` header reflects the sending BBS user while the SMTP `Sender:` header and envelope MAIL FROM are set to `defaultFrom`. This matches the standard "on behalf of" pattern used by mailing lists and keeps bounces deliverable to the authenticated mailbox.

> :warning: Your SMTP provider must allow the authenticated account to send as other local-parts within the configured domain. Verify this in your provider's settings (most providers allow this for any address in a verified domain).

> :information_source: The sanitized local-part is checked against `users.badUserNames` before use. If a user's sanitized name collides with a reserved name, that message falls back to `defaultFrom`.

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
| `inbound.imap.processedFolder` | *(none)* | IMAP folder to move successfully imported messages into. If omitted, messages stay in INBOX marked `\Seen` |
| `inbound.imap.failedFolder` | *(none)* | IMAP folder to move messages that could not be imported (unknown local recipient, parse error). If omitted, failed messages stay in INBOX marked `\Seen`. Either way, a copy is saved locally as `.eml` in `mail/email/failed/` for sysop review |
| `inbound.imap.maxMessagesPerRun` | `50` | Maximum messages to import per poll cycle |

> :information_source: **Server-side message lifecycle:** the inbound poller **marks every processed message `\Seen`** — both imports that succeeded and imports that failed. This is intentional: a message that cannot be matched (e.g. addressed to a deleted local user) would otherwise be re-fetched on every poll and duplicated into `mail/email/failed/` indefinitely. Marking seen breaks that loop. Messages are **never deleted** by ENiGMA½ — retention of `processedFolder` / `failedFolder` / INBOX is entirely up to you or your provider.

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

    //  Optional: send as "<UserName>" <username@yourbbs.net> instead of
    //  always using defaultFrom. Requires your SMTP provider to allow
    //  the authenticated account to send as other local-parts.
    outbound: {
        fromDomain: yourbbs.net
    }

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

            //  Move successfully imported messages here on the IMAP server
            processedFolder: "BBS-Processed"

            //  Move messages that couldn't be matched to a local user here
            //  (optional — defaults to leaving them in INBOX marked \Seen)
            failedFolder: "BBS-Failed"
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

Messages that cannot be delivered to a local user (unknown username, parse error) are:

- Saved locally as raw `.eml` files in `mail/email/failed/`. The filename includes a timestamp and a short reason code (e.g. `1712345678901_no_user.eml`).
- Marked `\Seen` on the IMAP server so they are not re-fetched on the next poll.
- Moved to `inbound.imap.failedFolder` if configured, otherwise left in INBOX (read).

Sysops can inspect the local `.eml` files with any email client or text editor to diagnose routing issues. Using `failedFolder` keeps the server-side INBOX tidy and makes it easy to re-run a message (e.g. after creating the missing local user) by moving it back into INBOX and clearing its `\Seen` flag.

## See Also

- [Email Configuration](../configuration/email.md) — SMTP transport setup
- [Message Networks](message-networks.md) — Overview of all supported networks
- [Configuring a Message Area](configuring-a-message-area.md) — Private mail area setup
