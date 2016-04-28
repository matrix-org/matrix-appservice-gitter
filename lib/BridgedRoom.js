"use strict";

var rp = require("request-promise");

var RemoteUser = require("matrix-appservice-bridge").RemoteUser;

function BridgedRoom(bridge, config, gitter, matrixRoomModel, gitterRoomModel) {
  this._bridge = bridge;
  this._config = config;
  this._gitter = gitter;
  this._matrixRoomModel = matrixRoomModel;
  this._gitterRoomModel = gitterRoomModel;

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

BridgedRoom.prototype.matrixRoomId = function() {
  return this._matrixRoomModel.getId();
};

BridgedRoom.prototype.gitterRoomName = function() {
  return this._gitterRoomModel.getId();
};

BridgedRoom.prototype.joinAndStart = function() {
  // We have to find out our own gitter user ID so we can ignore reflections of
  // messages we sent
  //
  // TODO(paul): consider how to memoize this as it's not going to change every time
  //   we join a new room
  return this._gitter.currentUser().then((u) => {
    var gitterUserId = u.id;
    this._gitterUserId = gitterUserId;

    return this._gitter.rooms.join(this.gitterRoomName()).then((room) => {
      this._gitterRoom = room;

      var events = room.streaming().chatMessages();

      events.on('chatMessages', (message) => {
        if (!message.model.fromUser || message.model.fromUser.id == gitterUserId) {
          // Ignore a reflection of my own messages
          return;
        }

        if (message.operation !== 'create' && message.operation !== 'update') {
          return;
        }

        this.onGitterMessage(message);
      });
    });
  });
};

BridgedRoom.prototype.stopAndLeave = function() {
  this._gitterRoom.streaming().disconnect();

  return this._gitterRoom.removeUser(this._gitterUserId);
};

function quotemeta(s) { return s.replace(/\W/g, '\\$&'); }

BridgedRoom.prototype.onGitterMessage = function(message) {
  var fromUser = message.model.fromUser;

  console.log('gitter->' + this.gitterRoomName() + ' from ' + fromUser.username + ':', message.model.text)

  var intent = this._bridge.getIntentFromLocalpart('gitter_' + fromUser.username);

  this._bridge.getRemoteUser(fromUser.username).then((remote_user) => {
    intent.setDisplayName(fromUser.displayName + ' (Gitter)');
    // TODO(paul): this sets the profile name *every* line. Surely there's a way to do
    // that once only, lazily, at user account creation time?

    var avatar_url = fromUser.avatarUrlMedium;

    if (remote_user && remote_user.get("avatar_url") == avatar_url)
      return;

    if(!remote_user)
      remote_user = new RemoteUser(fromUser.username, {});

    return this._setUserAvatar(intent, remote_user, avatar_url)
      .catch((e) => {
        console.log("Updating user avatar failed:", e);
        // ignore the failure and continue anyway
      });
  }).then(() => {
    var matrixMessage = {
      msgtype: "m.text",
      body: message.model.text,
    };

    // Pull out the HTML part of the body if it's not just plain text
    if (message.model.html != message.model.text) {
      matrixMessage["format"] = "org.matrix.custom.html";
      matrixMessage["formatted_body"] = message.model.html;
    }

    if (message.model.status) {
      matrixMessage["msgtype"] = "m.emote";

      // Strip the leading @username mention from the body text
      var userNameQuoted = quotemeta(fromUser.username);

      matrixMessage["body"] =
        matrixMessage["body"].replace(new RegExp("^@" + userNameQuoted + " "), "");

      // TODO(paul): HTML is harder. Applying regexp mangling to an HTML string.
      //   This is terrible. kegan - please help ;)
      matrixMessage["formatted_body"] =
        matrixMessage["formatted_body"].replace(new RegExp("^<span [^>]+>@" + userNameQuoted + "</span> "), "");
    }

    // TODO(paul): consider if we want to annotate somehow if message.operation was
    //   'update'

    return intent.sendMessage(this.matrixRoomId(), matrixMessage);
  });
};

// Helpers for the above
BridgedRoom.prototype._setUserAvatar = function(intent, remote_user, avatar_url) {
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

    return this._bridge.putRemoteUser(remote_user);
  });
};

BridgedRoom.prototype.onMatrixMessage = function(message) {
  // gitter supports Markdown. We'll use that to apply a little formatting
  // to make understanding the text a little easier
  var from = message.user_id;
  var rules = this._name_mangling_rules;

  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    var matches = rule.pattern.exec(from);
    if (!matches)
      continue;

    // TODO: more groups?
    from = rule.template.replace('$1', matches[1]);
    break;
  }

  if (message.content.msgtype == 'm.emote') {
    var text = '*' + from + '* ' + message.content.body;
    this._gitterRoom.sendStatus(text);
  }
  else {
    var text = '*<' + from + '>*: ' + message.content.body;
    this._gitterRoom.send(text);
  }
};

module.exports = BridgedRoom;
