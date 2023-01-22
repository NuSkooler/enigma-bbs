/* jslint node: true */
'use strict';

const EnigmaAssert = require('./enigma_assert.js');
const Address = require('./ftn_address.js');
const { AddressFlavor } = require('./message.js');
const Message = require('./message.js');

exports.getAddressedToInfo = getAddressedToInfo;
exports.setExternalAddressedToInfo = setExternalAddressedToInfo;
exports.copyExternalAddressedToInfo = copyExternalAddressedToInfo;

const EMAIL_REGEX =
    /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[?[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}]?)|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;

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
    @JoeUser@some.host.com             { name : 'Joe User', flavor : 'activitypub', remote 'JoeUser@some.host.com' }
*/
function getAddressedToInfo(input) {
    input = input.trim();

    const firstAtPos = input.indexOf('@');

    if (firstAtPos < 0) {
        let addr = Address.fromString(input);
        if (Address.isValidAddress(addr)) {
            return { flavor: AddressFlavor.FTN, remote: input };
        }

        const lessThanPos = input.indexOf('<');
        if (lessThanPos < 0) {
            return { name: input, flavor: AddressFlavor.Local };
        }

        const greaterThanPos = input.indexOf('>');
        if (greaterThanPos < lessThanPos) {
            return { name: input, flavor: AddressFlavor.Local };
        }

        addr = Address.fromString(input.slice(lessThanPos + 1, greaterThanPos));
        if (Address.isValidAddress(addr)) {
            return {
                name: input.slice(0, lessThanPos).trim(),
                flavor: AddressFlavor.FTN,
                remote: addr.toString(),
            };
        }

        return { name: input, flavor: AddressFlavor.Local };
    }

    if (firstAtPos === 0) {
        const secondAtPos = input.indexOf('@', 1);
        if (secondAtPos > 0) {
            const m = input.slice(1).match(EMAIL_REGEX);
            if (m) {
                return {
                    name: input.slice(1, secondAtPos),
                    flavor: AddressFlavor.ActivityPub,
                    remote: input.slice(firstAtPos),
                };
            }
        }
    }

    const lessThanPos = input.indexOf('<');
    const greaterThanPos = input.indexOf('>');
    if (lessThanPos > 0 && greaterThanPos > lessThanPos) {
        const addr = input.slice(lessThanPos + 1, greaterThanPos);
        const m = addr.match(EMAIL_REGEX);
        if (m) {
            return {
                name: input.slice(0, lessThanPos).trim(),
                flavor: AddressFlavor.Email,
                remote: addr,
            };
        }

        return { name: input, flavor: AddressFlavor.Local };
    }

    let m = input.match(EMAIL_REGEX);
    if (m) {
        return {
            name: input.slice(0, firstAtPos),
            flavor: AddressFlavor.Email,
            remote: input,
        };
    }

    let addr = Address.fromString(input); //  5D?
    if (Address.isValidAddress(addr)) {
        return { flavor: AddressFlavor.FTN, remote: addr.toString() };
    }

    addr = Address.fromString(input.slice(firstAtPos + 1).trim());
    if (Address.isValidAddress(addr)) {
        return {
            name: input.slice(0, firstAtPos).trim(),
            flavor: AddressFlavor.FTN,
            remote: addr.toString(),
        };
    }

    return { name: input, flavor: AddressFlavor.Local };
}

/// returns true if it's an external address
function setExternalAddressedToInfo(addressInfo, message) {
    const isValidAddressInfo = () => {
        return addressInfo.name.length > 1 && addressInfo.remote.length > 1;
    };

    switch (addressInfo.flavor) {
        case AddressFlavor.FTN:
        case AddressFlavor.Email:
        case AddressFlavor.QWK:
        case AddressFlavor.NNTP:
        case AddressFlavor.ActivityPub:
            EnigmaAssert(isValidAddressInfo());

            message.setRemoteToUser(addressInfo.remote);
            message.setExternalFlavor(addressInfo.flavor);
            message.toUserName = addressInfo.name;
            return true;

        default:
        case AddressFlavor.Local:
            return false;
    }
}

function copyExternalAddressedToInfo(fromMessage, toMessage) {
    const sm = Message.SystemMetaNames;
    toMessage.setRemoteToUser(fromMessage.meta.System[sm.RemoteFromUser]);
    toMessage.setExternalFlavor(fromMessage.meta.System[sm.ExternalFlavor]);
}
