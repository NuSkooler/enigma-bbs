/* jslint node: true */
'use strict';

//
//  Common Activitypub actor properties used throughout the system.
//
//  This IS NOT a full list. For example, custom modules
//  can utilize their own properties as well!
//
exports.ActorProps = {
    Type: 'type',
    PreferredUsername: 'preferred_user_name',
    Name: 'name',
    Summary: 'summary',
    IconUrl: 'icon_url',
    BannerUrl: 'banner_url',
    PublicKeyMain: 'public_key_main_rsa_pem', // RSA public key for user
};

exports.AllActorProperties = Object.values(exports.ActorProps);
