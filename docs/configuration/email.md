---
layout: page
title: Email
---
ENiGMA½ uses email to send password reset information to users. For it to work, you need to provide valid SMTP 
config in your [config.hjson]({{ site.baseurl }}{% link configuration/config-hjson.md %})

## SMTP Services

If you don't have an SMTP server to send from, [Sendgrid](https://sendgrid.com/) provide a reliable free
service.

## Example SMTP Configuration

```hjson
email: {
    defaultFrom: sysop@bbs.force9.org
    
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
}
```