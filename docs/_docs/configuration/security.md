---
layout: page
title: Security
---
## Security
Unlike in the golden era of BBSing, modern Internet-connected systems are prone to hacking attempts, eavesdropping, etc. While plain-text passwords, insecure data over [Plain Old Telephone Service (POTS)](https://en.wikipedia.org/wiki/Plain_old_telephone_service), and so on was good enough then, modern systems must employ protections against attacks. ENiGMA½ comes with many security features that help keep the system and your users secure — not limited to:
* Passwords are **never** stored in plain-text, but instead are stored using [Password-Based Key Derivation Function 2 (PBKDF2)](https://en.wikipedia.org/wiki/PBKDF2). Even the system operator can _never_ know your password!
* Alternatives to insecure Telnet logins are built in: [SSH](https://en.wikipedia.org/wiki/Secure_Shell) and secure [WebSockets](https://en.wikipedia.org/wiki/WebSocket) for example.
* A built in web server with [TLS](https://en.wikipedia.org/wiki/Transport_Layer_Security) support (aka HTTPS).
* Optional [Two-Factor Authentication (2FA)](https://en.wikipedia.org/wiki/Multi-factor_authentication) via [One-Time-Password (OTP)](https://en.wikipedia.org/wiki/One-time_password) for users, supporting [Google Authenticator](http://google-authenticator.com/), [Time-Based One-Time Password Algorithm (TOTP, RFC-6238)](https://tools.ietf.org/html/rfc6238), and [HMAC-Based One-Time Password Algorithm (HOTP, RFC-4266)](https://tools.ietf.org/html/rfc4226).

## Two-Factor Authentication via One-Time Password
Enabling Two-Factor Authentication via One-Time-Password (2FA/OTP) on an account adds an extra layer of security ("_something a user has_") in addition to their password ("_something a user knows_"). Providing 2FA/OTP to your users has some prerequisites:
* [A configured email gateway](../configuration/email.md) such that the system can send out emails.
* One or more secure servers enabled such as [SSH](../servers/ssh.md) or secure [WebSockets](../servers/websocket.md) (that is, WebSockets over a secure connection such as TLS).
* The [web server](../servers/web-server.md) enabled and exposed over TLS (HTTPS).

> :information_source: For WebSockets and the web server, ENiGMA½ _may_ listen on insecure channels if behind a secure web proxy.

### User Registration Flow
Due to the nature of 2FA/OTP, even if enabled on your system, users must opt-in and enable this feature on their account. Users must also have a valid email address such that a registration link can be sent to them. To opt-in, users must enable the option, which will cause the system to email them a registration link. Following the link provides the following:

1. A secret for manual entry into a OTP device.
2. If applicable, a scannable QR code for easy device entry (e.g. Google Authenticator)
3. A confirmation prompt in which the user must enter a OTP code. If entered correctly, this validates everything is set up properly and 2FA/OTP will be enabled for the account. Backup codes will also be provided at this time. Future logins will now prompt the user for their OTP after they enter their standard password.

> :warning: Serving 2FA/OTP registration links over insecure (HTTP) can expose secrets intended for the user and is **highly** discouraged!

> :memo: +ops can also manually enable or disable 2FA/OTP for a user using [oputil](../admin/oputil.md), but this is generally discouraged.

#### Recovery
In the situation that a user loses their 2FA/OTP device (such as a lost phone with Google Auth), there are some options:
* Utilize one of their backup codes.
* Contact the SysOp.

:warning: There is no way for a user to disable 2FA/OTP without first fully logging in! This is by design as a security measure.

### ACS Checks
Various places throughout the system that implement [ACS](../configuration/acs.md) can make 2FA specific checks:
* `AR#`: Current users **required** authentication factor. `AR2` for example means 2FA/OTP is required for this user.
* `AF#`: Current users **active** authentication factor. `AF2` means the user is authenticated with some sort of 2FA (such as One-Time-Password).

See [ACS](../configuration/acs.md) for more information.

#### Example
The following example illustrates using an `AR` ACS check to require applicable users to go through an additional 2FA/OTP process during login:

```hjson
login: {
    art: USERLOG
    next: [
        {
            //  users with AR2+ must first pass 2FA/OTP
            acs: AR2
            next: loginTwoFactorAuthOTP
        }
        {
            //  everyone else skips ahead
            next: fullLoginSequenceLoginArt
        }
    ]
    // ...
}
```