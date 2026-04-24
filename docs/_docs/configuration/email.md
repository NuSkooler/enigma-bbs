---
layout: page
title: Email
---
## Email Support

ENiGMA½ uses email for system notifications (password resets, 2FA registration) as well as user-to-internet email send/receive via the [Internet Mail](../messageareas/internet-mail.md) scanner/tosser.

Email is powered by [Nodemailer](https://nodemailer.com/about/), which supports SMTP directly as well as many pre-defined service shortcuts. The `transport` block within `email` must be Nodemailer-compatible.

## Services

If you don't have an SMTP server to send from, [Sendgrid](https://sendgrid.com/) and [Zoho](https://www.zoho.com/mail/) both provide reliable and free (or low-cost) services.

## Example Configurations

Example 1 — SMTP:
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

Example 2 — Zoho:
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

## Password Reset / Account Unlock

If email is configured and you allow email-driven password resets, you may also allow locked accounts to be unlocked at reset time. This is controlled by `users.unlockAtEmailPwReset`. If an account is locked due to too many failed login attempts, the user can reset their password to remedy the situation themselves.

## Internet Mail (Send & Receive)

To enable users to send and receive internet email from within ENiGMA½, see [Internet Mail](../messageareas/internet-mail.md).
