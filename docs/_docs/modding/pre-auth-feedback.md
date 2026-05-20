---
layout: page
title: Pre-Auth Feedback
---
## Pre-Auth Feedback

The `pre_auth_feedback` module lets unauthenticated visitors send a private message to the sysop **before logging in** — directly from the login matrix. This is distinct from [`page_sysop`](sysop-chat.md), which requires an authenticated user.

The sender types a free-text name in the From field. It is stored as-is and **never resolved to a user account**, so a malicious visitor cannot impersonate an existing user. The To field is locked to the sysop. The full FSE editor is used for composition.

Because the sender has no account, **replies to these messages are blocked**: attempting to reply from the inbox shows the `preAuthFeedbackNoReply` notice and returns to the inbox rather than opening a compose screen that would silently discard the mail.

---

## Enabling the Feature

1. Add a `feedback` item to your login `matrix` menu's `VM1` items list and wire it to `@menu:preAuthFeedback`.
2. Add a `preAuthFeedback` menu entry to your login menu config (see `misc/menu_templates/login.in.hjson` for a complete example).
3. Create art `msg_op_feedback_header` with `ET1` (From — editable), `ET2` (To — locked), `ET3` (Subject — editable), and optional `TL4` (error message). The body, footer, and help art reuse the standard `MSGBODY`, `MSGEFTR`, `MSGEMFT`, `MSGEHLP` files.
4. Create art `PREAFNRPLY` for the "cannot reply" notice shown to the sysop. The menu auto-advances to `prevMenu` after 3 seconds.
5. Add a `preAuthFeedback` theme block (see `theme.hjson`) matching the MCI widths and body `MT1` height — copy from `privateMailMenuCreateMessage`.

---

## Art Files

| Spec | Description | Key MCI |
|------|-------------|---------|
| `msg_op_feedback_header` | Header form — From (editable), To (locked), Subject (editable), optional error | `ET1` (from), `ET2` (to), `ET3` (subject), `TL4` (error) |
| `PREAFNRPLY` | Notice shown when sysop attempts to reply to a ghost-sender message | none required |

---

## `preAuthFeedback` Menu Config Keys

| Key | Default | Description |
|-----|---------|-------------|
| `sysopUserName` | `Sysop` | Display name shown in the locked To field |
| `defaultFromName` | `""` | Seed value for the editable From field |
| `defaultSubject` | `Feedback to Sysop` | Pre-populated Subject (user may edit) |
| `noReplyGhostSenderMenu` | `preAuthFeedbackNoReply` | Menu shown when sysop attempts to reply |

---

## Theming

Add a `preAuthFeedback` block to your `theme.hjson`, matching the MCI view widths from your art file and the body `MT1` height:

```hjson
preAuthFeedback: {
    0: {
        mci: {
            ET1: { width: 19, textOverflow: "..." }
            ET2: { width: 19, textOverflow: "..." }
            ET3: { width: 19, textOverflow: "..." }
        }
    }
    1: {
        mci: {
            MT1: { height: 14 }
        }
    }
}
```

---

## See Also

* [Sysop Chat](sysop-chat.md) — two-way split-screen chat and paging for authenticated users.
