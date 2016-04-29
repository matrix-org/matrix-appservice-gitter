"use strict";

var RemoteUser = require("matrix-appservice-bridge").RemoteUser;

function BridgedRoom(bridge, gitter, matrixRoomModel, gitterRoomModel) {
  this._bridge = bridge;
  this._gitter = gitter;
  this._matrixRoomModel = matrixRoomModel;
  this._gitterRoomModel = gitterRoomModel;
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
  return this._bridge.getGitterUserId().then((gitterUserId) => {
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

  var intent = this._bridge.getIntentFromGitterUser(fromUser);

  this._bridge.getRemoteUser(fromUser.username).then((remote_user) => {
    intent.setDisplayName(fromUser.displayName + ' (Gitter)');
    // TODO(paul): this sets the profile name *every* line. Surely there's a way to do
    // that once only, lazily, at user account creation time?

    var avatar_url = fromUser.avatarUrlMedium;

    if (remote_user && remote_user.get("avatar_url") == avatar_url)
      return;

    if(!remote_user)
      remote_user = new RemoteUser(fromUser.username, {});

    return this._bridge.setUserAvatar(intent, remote_user, avatar_url)
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

BridgedRoom.prototype.onMatrixMessage = function(message) {
  var from = this._bridge.mangleName(message.user_id);

  // gitter supports Markdown. We'll use that to apply a little formatting
  // to make understanding the text a little easier
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
