"use strict";

var Promise = require("bluebird");

function GitterUser(bridge, remoteUserModel) {
  this._bridge = bridge;
  this._remoteUserModel = remoteUserModel;
}

GitterUser.prototype.updateAvatar = function(url) {
  if (this._remoteUserModel.get("avatar_url") == url)
    return Promise.resolve();

  return this._bridge.setUserAvatar(this._remoteUserModel, url);
};

module.exports = GitterUser;
