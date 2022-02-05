---
layout: page
title: Email
---
## Email Support
ENiGMA½ uses email to send password reset information to users. For it to work, you need to provide valid [Nodemailer](https://nodemailer.com/about/) compatible `email` block in your [config.hjson](config-hjson.md). Nodemailer supports SMTP in addition to many pre-defined services for ease of use. The `transport` block within `email` must be Nodemailer compatible.

Additional email support will come in the near future.

## Services

If you don't have an SMTP server to send from, [Sendgrid](https://sendgrid.com/) and [Zoho](https://www.zoho.com/mail/) both provide reliable and free services.

## Example Configurations

Example 1 - SMTP:
```hjson
email: {
    defaultFrom: sysop@bbs.awesome.com
    
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

Example 2 - Zoho
```hjson
email: {
    defaultFrom: sysop@bbs.awesome.com

    transport: {
        service: Zoho
        auth: {
            user: noreply@bbs.awesome.com
            pass: yuspymypass
        }
    }
}
```

## Lockout Reset
If email is available on your system and you allow email-driven password resets, you may elect to allow unlocking accounts at the time of a password reset. This is controlled by the `users.unlockAtEmailPwReset` configuration option. If an account is locked due to too many failed login attempts, a user may reset their password to remedy the situation themselves.
