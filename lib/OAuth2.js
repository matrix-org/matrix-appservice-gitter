"use strict";

/*
 * TODO(paul): This file shamelessly copypasted from matrix-appservice-slack
 *   and edited inplace. It might be nice to find a way to factor out the
 *   common bits, but then they'd be so small and parameterised it might not
 *   be worth it.
 */

var qs = require("qs");
var rp = require('request-promise');

var URLS = {
    authorize: "https://gitter.im/login/oauth/authorize",
    token:     "https://gitter.im/login/oauth/token",
};

function OAuth2(opts) {
    this._main = opts.main,

    this._client_id = opts.client_id;
    this._client_secret = opts.client_secret;
    this._redirect_url = opts.redirect_url;
}

OAuth2.prototype.makeAuthorizeURL = function(opts) {
    return URLS.authorize + "?" + qs.stringify({
        client_id: this._client_id,
        redirect_uri: this._redirect_url,
        response_type: "code",
        state: opts.state,
    });
};

OAuth2.prototype.exchangeCodeForToken = function(opts) {
    this._main.incRemoteCallCounter("oauth.access");
    return rp({
        method: "POST",
        uri: URLS.token,
        body: {
            client_id: this._client_id,
            client_secret: this._client_secret,
            code: opts.code,
            redirect_uri: this._redirect_url,
            grant_type: "authorization_code",
        },
        json: true
    }).then((response) => {
        return {
            access_token: response.access_token,
        };
    });
};

module.exports = OAuth2;
