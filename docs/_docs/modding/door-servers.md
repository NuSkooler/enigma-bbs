---
layout: page
title: Door Servers
---
## The bbs_link Module
Native support for [BBSLink](http://www.bbslink.net/) doors is provided via the `bbs_link` module.

Configuration for a BBSLink door is straight forward. Take a look at the following example for launching Tradewars 2002:

```hjson
doorTradeWars2002BBSLink: {
	desc: Playing TW 2002 (BBSLink)
	module: bbs_link
	config: {
		sysCode: XXXXXXXX
		authCode: XXXXXXXX
		schemeCode: XXXXXXXX
		door: tw
	}
}

```

Fill in your credentials in `sysCode`, `authCode`, and `schemeCode` and that's it!

## The door_party Module
The module `door_party` provides native support for [DoorParty!](http://www.throwbackbbs.com/) Configuration is quite easy:

```hjson
doorParty: {
    desc: Using DoorParty!
    module: door_party
    config: {
        username: XXXXXXXX
        password: XXXXXXXX
        bbsTag: XX
    }
}
```

Fill in `username`, `password`, and `bbsTag` with credentials provided to you and you should be in business!

## The CombatNet Module
The `combatnet` module provides native support for [CombatNet](http://combatnet.us/). Add the following to your menu config:

````hjson
combatNet: {
    desc: Using CombatNet
    module: combatnet
    config: {
        bbsTag: CBNxxx
        password: XXXXXXXXX
    }
}
````
Update `bbsTag` (in the format CBNxxx) and `password` with the details provided when you register, then
you should be ready to rock!

## The Exodus Module

TBC