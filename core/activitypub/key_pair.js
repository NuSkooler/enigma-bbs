'use strict';

//
//  The key pair an ActivityPub actor signs with: RSA 4096, the public key as
//  SPKI PEM (publicKeyPem in the actor document) and the private key as
//  PKCS#8 PEM. Used for local users (User#updateActivityPubKeyPairProperties)
//  and the instance actor (instance_actor.js). No requires of our own: the
//  user module loads this.
//

const crypto = require('crypto');

exports.generateActorKeyPair = generateActorKeyPair;

//  cb(err, { publicKey, privateKey })
function generateActorKeyPair(cb) {
    crypto.generateKeyPair(
        'rsa',
        {
            modulusLength: 4096,
            publicKeyEncoding: {
                type: 'spki',
                format: 'pem',
            },
            privateKeyEncoding: {
                type: 'pkcs8',
                format: 'pem',
            },
        },
        (err, publicKey, privateKey) => {
            if (err) {
                return cb(err);
            }
            return cb(null, { publicKey, privateKey });
        }
    );
}
