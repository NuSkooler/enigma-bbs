/* jslint node: true */
'use strict';

const Address = require('./ftn_address.js');
const Message = require('./message.js');

exports.getAddressedToInfo = getAddressedToInfo;

const EMAIL_REGEX =
    /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;

/*
    Input                              Output
    ----------------------------------------------------------------------------------------------------
    User                               { name : 'User', flavor : 'local' }
    Some User                          { name : 'Some User', flavor : 'local' }
    JoeUser @ 1:103/75                 { name : 'JoeUser', flavor : 'ftn', remote : '1:103/75' }
    Bob@1:103/705@fidonet.org          { name : 'Bob', flavor : 'ftn', remote : '1:103/705@fidonet.org' }
    1:103/705@fidonet.org              { flavor : 'ftn', remote : '1:103/705@fidonet.org' }
    Jane <23:4/100>                    { name : 'Jane', flavor : 'ftn', remote : '23:4/100' }
    43:20/100.2                        { flavor : 'ftn', remote : '43:20/100.2' }
    foo@host.com                       { name : 'foo', flavor : 'email', remote : 'foo@host.com' }
    Bar <baz@foobar.net>               { name : 'Bar', flavor : 'email', remote : 'baz@foobar.com' }
*/
function getAddressedToInfo(input) {
    input = input.trim();

    const firstAtPos = input.indexOf('@');

    if (firstAtPos < 0) {
        let addr = Address.fromString(input);
        if (Address.isValidAddress(addr)) {
            return { flavor: Message.AddressFlavor.FTN, remote: input };
        }

        const lessThanPos = input.indexOf('<');
        if (lessThanPos < 0) {
            return { name: input, flavor: Message.AddressFlavor.Local };
        }

        const greaterThanPos = input.indexOf('>');
        if (greaterThanPos < lessThanPos) {
            return { name: input, flavor: Message.AddressFlavor.Local };
        }

        addr = Address.fromString(input.slice(lessThanPos + 1, greaterThanPos));
        if (Address.isValidAddress(addr)) {
            return {
                name: input.slice(0, lessThanPos).trim(),
                flavor: Message.AddressFlavor.FTN,
                remote: addr.toString(),
            };
        }

        return { name: input, flavor: Message.AddressFlavor.Local };
    }

    const lessThanPos = input.indexOf('<');
    const greaterThanPos = input.indexOf('>');
    if (lessThanPos > 0 && greaterThanPos > lessThanPos) {
        const addr = input.slice(lessThanPos + 1, greaterThanPos);
        const m = addr.match(EMAIL_REGEX);
        if (m) {
            return {
                name: input.slice(0, lessThanPos).trim(),
                flavor: Message.AddressFlavor.Email,
                remote: addr,
            };
        }

        return { name: input, flavor: Message.AddressFlavor.Local };
    }

    let m = input.match(EMAIL_REGEX);
    if (m) {
        return {
            name: input.slice(0, firstAtPos),
            flavor: Message.AddressFlavor.Email,
            remote: input,
        };
    }

    let addr = Address.fromString(input); //  5D?
    if (Address.isValidAddress(addr)) {
        return { flavor: Message.AddressFlavor.FTN, remote: addr.toString() };
    }

    addr = Address.fromString(input.slice(firstAtPos + 1).trim());
    if (Address.isValidAddress(addr)) {
        return {
            name: input.slice(0, firstAtPos).trim(),
            flavor: Message.AddressFlavor.FTN,
            remote: addr.toString(),
        };
    }

    return { name: input, flavor: Message.AddressFlavor.Local };
}
