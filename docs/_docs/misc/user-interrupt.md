---
layout: page
title: User Interruptions
---
## User Interruptions
ENiGMA½ provides functionality to "interrupt" a user for various purposes such as a [node-to-node message](../modding/node-msg.md). User interruptions can be queued and displayed at the next opportune time such as when switching to a new menu, or realtime if appropriate.

## Standard Menu Behavior
Standard menus control interruption by the `interrupt` config block option, which may be set to one of the following values:
* `never`: Never interrupt the user when on this menu.
* `queued`: Queue interrupts for the next opportune time. Any queued message(s) will then be shown. This is the default.
* `realtime`: If possible, display messages in realtime. That is, show them right away. Standard menus that do not override default behavior will show the message then reload.


## See Also
See [user_interrupt_queue.js](/core/user_interrupt_queue.js) as well as usage within [menu_module.js](/core/menu_module.js).

