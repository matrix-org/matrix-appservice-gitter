"use strict";

var Promise = require("bluebird");

var GitterUser = require("./GitterUser");

var RemoteUser = require("matrix-appservice-bridge").RemoteUser;

function MatrixGitterBridge(bridge, gitter, config) {
  this._bridge = bridge;
  this._gitter = gitter;
  this._gitterUserId = null;

  this._gitterusers = {};

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

MatrixGitterBridge.prototype.getMyGitterUserId = function() {
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

MatrixGitterBridge.prototype.mapGitterUser = function(user) {
  var id = user.id;

  return this._gitterusers[id] = (this._gitterusers[id] ||
      this.getRemoteUser(id).then((model) => {
        if(!model)
          model = new RemoteUser(id, {username: user.username});

        return new GitterUser(this, model);
      }));
};

MatrixGitterBridge.prototype.getGitterUserById = function(id) {
  var user = this._gitterusers[id];
  if (user)
    return user;

  return this.getRemoteUser(id).then((model) => {
    if (!model)
      return Promise.resolve();

    user = Promise.resolve(new GitterUser(this, model));
    this._gitterusers[id] = user;
    return user;
  });
};

MatrixGitterBridge.prototype.getIntentFromLocalpart = function(localpart) {
  return this._bridge.getIntentFromLocalpart(localpart);
};

MatrixGitterBridge.prototype.getRemoteUser = function(id) {
  return this._bridge.getUserStore().getRemoteUser(id);
};

MatrixGitterBridge.prototype.putRemoteUser = function(user) {
  return this._bridge.getUserStore().setRemoteUser(user);
};

module.exports = MatrixGitterBridge;
