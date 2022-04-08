---
layout: page
title: 2FA/OTP Config
---
## The 2FA/OTP Config Module
The `user_2fa_otp_config` module provides opt-in, configuration, and viewing of Two-Factor Authentication via One-Time-Password (2FA/OTP) settings. In order to allow users access to 2FA/OTP, the system must be properly configured. See [Security](../configuration/security.md) for more information.

:information_source: By default, the 2FA/OTP configuration menu may only be accessed by users connected securely (ACS `SC`). It is highly recommended to leave this default as accessing these settings over a plain-text connection could expose private secrets!

## Configuration

### Config Block
Available `config` block entries:
* `infoText`: Overrides default informational text string(s). See **Info Text** below.
* `statusText:` Overrides default status text string(s). See **Status Text** below.

Example:
```hjson
config: {
    infoText: {
        googleAuth: Google Authenticator available on mobile phones, etc.
    }
    statusText: {
        saveError: Doh! Failed to save :(
    }
}
```

#### Info Text (infoText)
Overrides default informational text relative to current selections. Available keys:
* `disabled`: Displayed when OTP switched to enabled.
* `enabled`: Displayed when OTP switched to disabled.
* `rfc6238_TOTP`: Describes TOTP.
* `rfc4266_HOTP`: Describes HOTP.
* `googleAuth`: Describes Google Authenticator OTP.

#### Status Text (statusText)
Overrides default status text for various conditions. Available keys:
* `otpNotEnabled`
* `noBackupCodes`
* `saveDisabled`
* `saveEmailSent`
* `saveError`
* `qrNotAvail`
* `emailRequired`

## Theming
The following MCI codes are available:
* MCI 1: (ie: `TM1`): Toggle 2FA/OTP enabled/disabled.
* MCI 2: (ie: `SM2`): 2FA/OTP type selection.
* MCI 3: (ie: `TM3`): Submit/cancel toggle.
* MCI 10...99: Custom entries with the following format members available:
    * `{infoText}`: **Info Text** for current selection.

### Web and Email Templates
A template system is also available to customize registration emails and the landing page.

#### Emails
Multipart MIME emails are send built using template files pointed to by `users.twoFactorAuth.otp.registerEmailText` and `users.toFactorAuth.otp.registerEmailHtml` supporting the following variables:
* `%BOARDNAME%`: BBS name.
* `%USERNAME%`: Username receiving email.
* `%TOKEN%`: Temporary registration token generally used in URL.
* `%REGISTER_URL%`: Full registration URL.

#### Landing Page
The landing page template is pointed to by `users.twoFactorAuth.otp.registerPageTemplate` and supports the following variables:
* `%BOARDNAME%`: BBS name.
* `%USERNAME%`: Username receiving email.
* `%TOKEN%`: Temporary registration token generally used in URL.
* `%OTP_TYPE%`: OTP type such as `googleAuth`.
* `%POST_URL%`: URL to POST form to.
* `%QR_IMG_DATA%`: QR code in URL image data format. Not always available depending on OTP type and will be set to blank in these cases.
* `%SECRET%`: Secret for manual entry.
