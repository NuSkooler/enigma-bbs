# MCI Codes

## Introduction
ENiGMA½ supports a variety of MCI codes. Some **predefined** codes produce information about the current user, system, or other statistics while others are used to instanciate a **View**. MCI codes are two characters in length and are prefixed with a percent (%) symbol. Some MCI codes have additional options that may be set directly from the code itself while others -- and more advanced options -- are controlled via the current theme. Standard (non-focus) and focus colors are set by placing duplicate codes back to back in art files.

## Views
A **View** is a control placed on a **form** that can display variable data or collect input. One example of a View is a Vertical Menu (`%VM`): Oldschool BBSers may recognize this as a lightbar menu.

### Available Views
* Text Label (`%TL`): Displays text
* Edit Text (`%ET`): Collect user input
* Masked Edit Text (`%ME`): Collect user input using a *mask*
* Multi Line Text Edit (`%MT`): Multi line edit control
* Button (`%BT`): A button
* Vertical Menu (`%VM`): A vertical menu aka a vertical lightbar
* Horizontal Menu (`%HM`): A horizontal menu aka a horizontal lightbar
* Spinner Menu (`%SM`): A spinner input control
* Toggle Menu (`%TM`): A toggle menu commonly used for Yes/No style input
* Key Entry (`%KE`): A *single* key input control

(Peek at `core/mci_view_factory.js` to see additional information on these)

## Predefined
There are many predefined MCI codes that can be used anywhere on the system (placed in any art file). More are added all the time so also check out `core/predefined_mci.js` for a full listing. Many codes attempt to pay homage to Oblivion/2, iNiQUiTY, etc.

* `BN`: Board Name
* `VL`: Version *label*, e.g. "ENiGMA½ v0.0.3-alpha"
* `VN`: Version *number*, eg.. "0.0.3-alpha"
* `SN`: SysOp username
* `SR`: SysOp real name
* `SL`: SysOp location
* `SA`: SysOp affiliations
* `SS`: SysOp sex
* `SE`: SysOp email address
* `UN`: Current user's username
* `UI`: Current user's user ID
* `UG`: Current user's group membership(s)
* `UR`: Current user's real name
* `LO`: Current user's location
* `UA`: Current user's age
* `BD`: Current user's birthdate (using theme date format)
* `US`: Current user's sex
* `UE`: Current user's email address
* `UW`: Current user's web address
* `UF`: Current user's affiliations
* `UT`: Current user's *theme ID* (e.g. "luciano_blocktronics")
* `UC`: Current user's login/call count
* `ND`: Current user's connected node number
* `IP`: Current user's IP address
* `ST`: Current user's connected server name (e.g. "Telnet" or "SSH")
* `FN`: Current user's active file base filter name
* `DN`: Current user's number of downloads
* `DK`: Current user's download amount (formatted to appropriate bytes/megs/etc.)
* `UP`: Current user's number of uploads
* `UK`: Current user's upload amount (formatted to appropriate bytes/megs/etc.)
* `NR`: Current user's upload/download ratio
* `KR`: Current user's upload/download *bytes* ratio
* `MS`: Current user's account creation date (using theme date format)
* `PS`: Current user's post count
* `PC`: Current user's post/call ratio
* `MD`: Current user's status/viewing menu/activity
* `MA`: Current user's active message area name
* `MC`: Current user's active message conference name
* `ML`: Current user's active message area description
* `CM`: Current user's active message conference description
* `SH`: Current user's term height
* `SW`: Current user's term width
* `DT`: Current date (using theme date format)
* `CT`: Current time (using theme time format)
* `OS`: System OS (Linux, Windows, etc.)
* `OA`: System architecture (x86, x86_64, arm, etc.)
* `SC`: System CPU model
* `NV`: System underlying Node.js version
* `AN`: Current active node count
* `TC`: Total login/calls to system
* `RR`: Displays a random rumor

A special `XY` MCI code may also be utilized for placement identification when creating menus.

## Properties & Theming
Predefined MCI codes and other Views can have properties set via `menu.hjson` and further *themed* via `theme.hjson`.

### Common Properties
* `textStyle`: Sets the standard (non-focus) text style to `normal` (as-is), `upper` (UPPER), `lower` (lower), `title` (Title Case), `first lower` (fIRST lOWER), `small vowels` (SMaLL VoWeLS), `big vowels` (bIg vOwELS), `small i` (ENiGMA), `mixed` (mIxED CAsE), or `l33t` (l337 5p34k)
* `focusTextStyle`: Sets focus text style to `normal` (as-is), `upper` (UPPER), `lower` (lower), `title` (Title Case), `first lower` (fIRST lOWER), `small vowels` (SMaLL VoWeLS), `big vowels` (bIg vOwELS), `small i` (ENiGMA), `mixed` (mIxED CAsE), or `l33t` (l337 5p34k)
* `itemSpacing`: Used to separate items in menus such as Vertical Menu and Horizontal Menu Views.
* `height`: Sets the height of views such as menus that may be > 1 character in height
* `width`: Sets the width of a view
* `focus`: If set to `true`, establishes initial focus
* `text`: (initial) text of a view
* `submit`: If set to `true` any `accept` action upon this view will submit the encompassing **form**

These are just a few of the properties set on various views. *Use the source Luke*, as well as taking a look at the default `menu.hjson` and `theme.hjson` files!