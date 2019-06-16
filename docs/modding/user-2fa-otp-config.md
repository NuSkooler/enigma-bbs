---
layout: page
title: TopX
---
## The 2FA/OTP Config Module
The `user_2fa_otp_config` module provides opt-in, configuration, and viewing of Two-Factor Authentication via One-Time-Password (2FA/OTP) settings. For more information on 2FA/OTP see [Security](/docs/configuration/security.md).

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
