"use strict";

var Promise = require("bluebird");

var rp = require("request-promise");

function MatrixGitterBridge(bridge, gitter, config) {
  this._bridge = bridge;
  this._gitter = gitter;
  this._gitterUserId = null;

  var rules = [];
  if (config.name_mangling) {
    for (var i = 0; i < config.name_mangling.length; i++) {
      var rule = config.name_mangling[i];

      rules.push({
        pattern: new RegExp(rule.pattern),
        template: rule.template
      });
    }
  }
  this._name_mangling_rules = rules;
}

MatrixGitterBridge.prototype.getGitterUserId = function() {
  if (this._gitterUserId)
    return Promise.resolve(this._gitterUserId);

  return this._gitter.currentUser().then((u) => {
    this._gitterUserId = u.id;
    return u.id;
  });
};

MatrixGitterBridge.prototype.mangleName = function(name) {
  var rules = this._name_mangling_rules;

  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    var matches = rule.pattern.exec(name);
    if (!matches)
      continue;

    // TODO: more groups?
    return rule.template.replace('$1', matches[1]);
  }

  return name;
}

MatrixGitterBridge.prototype.getIntentFromGitterUser = function(gitter_user) {
  var localpart = 'gitter_' + gitter_user.username;
  return this._bridge.getIntentFromLocalpart(localpart);
};

MatrixGitterBridge.prototype.getRemoteUser = function(id) {
  return this._bridge.getUserStore().getRemoteUser(id);
};

MatrixGitterBridge.prototype.putRemoteUser = function(user) {
  return this._bridge.getUserStore().setRemoteUser(user);
};

MatrixGitterBridge.prototype.setUserAvatar = function(intent, remote_user, avatar_url) {
  console.log("Updating " + remote_user.getId() + " avatar image from " + avatar_url);

  return rp({
    uri: avatar_url,
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
    remote_user.set("avatar_url", avatar_url);

    return this.putRemoteUser(remote_user);
  });
};

module.exports = MatrixGitterBridge;
