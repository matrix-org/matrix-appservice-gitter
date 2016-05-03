"use strict";

var Promise = require("bluebird");

var rp = require("request-promise");

function GitterUser(bridge, remoteUserModel) {
  this._bridge = bridge;
  this._remoteUserModel = remoteUserModel;
}

GitterUser.prototype.gitterId = function() {
  return this._remoteUserModel.getId();
};

GitterUser.prototype.gitterUsername = function() {
  return this._remoteUserModel.get("username");
};

GitterUser.prototype.getIntent = function() {
  return this._intent = this._intent || (
      this._bridge.getIntentFromLocalpart('gitter_' + this.gitterUsername()));
};

GitterUser.prototype.update = function(user) {
  return Promise.all([
      this.updateDisplayName(user.displayName),
      this.updateAvatar(user.avatarUrlMedium)
  ]);
};

GitterUser.prototype.updateDisplayName = function(name) {
  if (this._remoteUserModel.get("display_name") == name)
    return Promise.resolve();

  var intent = this.getIntent();

  return intent.setDisplayName(name + ' (Gitter)').then(() => {
    this._remoteUserModel.set("display_name", name);

    return this._bridge.putRemoteUser(this._remoteUserModel);
  });
};

GitterUser.prototype.updateAvatar = function(url) {
  if (this._remoteUserModel.get("avatar_url") == url)
    return Promise.resolve();

  console.log("Updating " + this.gitterUsername() + " avatar image from " + url);

  var intent = this.getIntent();

  return rp({
    uri: url,
    resolveWithFullResponse: true,
    encoding: null
  }).then((response) => {
    var content_type = response.headers["content-type"];

    return intent.getClient().uploadContent({
      stream: new Buffer(response.body, "binary"),
      name: "avatar.jpg",
      type: content_type,
    });
  }).then((response) => {
    var content_uri = JSON.parse(response).content_uri;

    console.log("Media uploaded to " + content_uri);
    return intent.setAvatarUrl(content_uri);
  }).then(() => {
    this._remoteUserModel.set("avatar_url", url);

    return this._bridge.putRemoteUser(this._remoteUserModel);
  });
};

module.exports = GitterUser;
