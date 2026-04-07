---
layout: page
title: Sysop Chat
---
## Sysop Chat

ENiGMA½ provides a two-way split-screen chat system between the sysop and any connected user. It is composed of two modules that work together:

* `page_sysop` — user-facing page flow
* `sysop_chat` — split-screen chat screen used by both parties

The sysop can also break into chat with any node directly from the [WFC](wfc.md) without waiting for a page.

---

## User Flow (Paging the Sysop)

The `pageSysop` menu entry drives the user side:

1. **Rate limited?** — The user sees rate-limit art (`PAGESYPLM`) or fallback text and returns to the previous menu.
2. **Sysop available?**
    * **No** — The user sees the "not available" art (`PAGESYPNA`) with a Y/N prompt offering to send their message as private mail addressed to the sysop instead.
    * **Yes** — The user sees the main page art (`PAGESYSP`) with an optional text input for a reason/message, then submits.
3. On a successful page: a session is created, all online sysops are alerted (per `pageAlert` config), and the user sees the confirmation art (`PAGESYSPOK`).

Sysops **at the WFC** are not sent an interrupt — they see the page reflected immediately in the node list (`pageIndicator`) and in the pending page tokens. Sysops **not at the WFC** receive an interrupt notification with the user's name, node, and message.

---

## Sysop Flow (WFC)

With a node selected in `VM1`, press `B` to break into chat:

* If that node has a **pending page**, the existing session is accepted.
* If there is **no pending page**, a new sysop-initiated session is created.

Both parties enter the `sysopChat` menu directly — no pre-chat confirmation is shown to the user.

---

## Chat Screen (`sysopChat` module)

Both parties use the same `sysopChat` menu entry. The role (`sysop` or `user`) is passed via `extraArgs.role`.

Art file: `SYSOPCHAT`

| MCI | Role | Description |
|-----|------|-------------|
| `%MT1` | Both | Sysop's scrollback panel (top) |
| `%ET2` | Sysop | Sysop's input line |
| `%MT3` | Both | User's scrollback panel (bottom) |
| `%ET4` | User | User's input line |
| `%TL10`+ | Both | Custom status tokens (see `chatInfoFormat10` etc.) |

Messages from either party appear in the **sender's panel** on both screens.

`ESC` ends the chat. The party that exits notifies the partner, who sees a brief "chat ended" message then exits automatically after a short delay.

---

## Art Files

| Spec | Module | Description | Key MCI |
|------|--------|-------------|---------|
| `PAGESYSP` | `page_sysop` | Main page form — user types optional reason | `%ET1` (message), `%TL10`+ |
| `PAGESYSPOK` | `page_sysop` | "Your page has been sent" confirmation | none required |
| `PAGESYPNA` | `page_sysop` | Sysop not available — combined with "send as mail?" Y/N | `%TM1` (Y/N confirm) |
| `PAGESYPLM` | `page_sysop` | Rate limit art (optional — fallback text used if missing) | none required |
| `SYSOPCHAT` | `sysop_chat` | Split-screen chat layout — drives panel geometry | `%MT1`, `%ET2`, `%MT3`, `%ET4`, `%TL10`+ |

---

## System Config (`sysopChat` block in `config.hjson`)

| Key | Default | Description |
|-----|---------|-------------|
| `pageCooldownMinutes` | `5` | Minimum minutes a user must wait between pages. |
| `pageAlert` | `bel` | Alert mode on page arrival: `bel` (sends `\x07` to sysop terminals), `none` (silent), or `command` (runs `pageAlertCommand`). |
| `pageAlertCommand` | `''` | Shell command run when `pageAlert` is `command`. Tokens: `{userName}`, `{nodeId}`, `{message}`. Example: `'notify-send "Page from {userName}" "{message}"'` |

---

## `pageSysop` Menu Config Keys

| Key | Default | Description |
|-----|---------|-------------|
| `notifyFormat` | pipe-colored text | Interrupt text sent to non-WFC sysops. Tokens: `{userName}`, `{nodeId}`, `{message}`, `{sessionId}` |
| `pageSentArt` | `PAGESYSPOK` | Art shown after a successful page |
| `notAvailableArt` | `PAGESYPNA` | Art shown when sysop unavailable (must contain `%TM1`) |
| `rateLimitArt` | `PAGESYPLM` | Art shown when rate-limited (optional; fallback text used if missing) |
| `rateLimitText` | pipe-colored string | Fallback text if `rateLimitArt` is missing |
| `mailSubject` | `Page from {userName}` | Subject for the "send as mail" path. Token: `{userName}` |
| `sysopUserName` | `Sysop` | Display name used as the mail recipient |
| `mailMenuName` | `privateMailMenuCreateMessage` | Menu navigated to for the mail compose path |

---

## `sysopChat` Menu Config Keys

| Key | Default | Description |
|-----|---------|-------------|
| `chatEndedText` | `\|08[ Chat session ended ]\|07` | Message shown in the sysop panel when the partner ends the chat |
| `messageFormat` | `\|15{userName}\|07: {message}` | Format for each sent message line. Tokens: `{userName}`, `{message}` |
| `chatInfoFormat10`+ | — | Custom-range status token format (standard ENiGMA pattern). Tokens: `{partnerName}`, `{duration}`, `{userName}`, `{userNode}` |

---

## Theming

### `prefixFormat` (per-view in `theme.hjson`)

Set `prefixFormat` on `ET2` or `ET4` in the `sysopChat` MCI theme block to display a role-specific label before the input line. Pipe codes are supported and render live as the user types.

```hjson
sysopChat: {
    0: {
        ET2: {
            prefixFormat: "|11{userName} |14> "
        }
        ET4: {
            prefixFormat: "|11{userName} |14> "
        }
    }
}
```

Token available: `{userName}`.
