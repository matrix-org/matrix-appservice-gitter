"use strict";

function BridgedRoom(opts) {
  this._bridge = opts.bridge;
  this._gitter = opts.gitter;
  this._gitterRealtime = opts.gitterRealtime;
  this._matrixRoomModel = opts.matrixRoomModel;
  this._gitterRoomModel = opts.gitterRoomModel;
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
  return this._bridge.getMyGitterUserId().then((gitterUserId) => {
    this._gitterUserId = gitterUserId;

    return this._gitter.rooms.join(this.gitterRoomName());
  }).then((room) => {
    this._gitterRoom = room;

    var events = room.streaming().chatMessages();

    events.on('chatMessages', (message) => {
      if (!message.model) return;

      if (!message.model.fromUser || message.model.fromUser.id == this._gitterUserId) {
        // Ignore a reflection of my own messages
        return;
      }

      if (message.operation == 'create' || message.operation == 'update') {
        this.onGitterMessage(message);
      }
    });

    this._gitterRealtime.subscribe("/v1/rooms/" + room.id, (message) => {
      this._bridge.getGitterUserById(message.userId).then((user) => {
        if (user) {
          user.setRoomPresence(room.id, message.status == 'in');
        }
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

  this._bridge.mapGitterUser(fromUser).then((user) => {
    return user.update(fromUser)
      .catch((e) => {
        console.log("Updating user failed:", e);
        // There's a lot that could go wrong in user.update(); e.g. the avatar
        //   image could be corrupted and the matrix media server would reject
        //   it. Lets not let a failure there get in the way of message
        //   relaying - we'll ignore the failure here and continue anyway.
      }).then(() => {
        return user;
      });
  }).then((user) => {
    var matrixMessage = {
      msgtype: "m.text",
      body: message.model.text,
    };

    // Pull out the HTML part of the body if it's not just plain text
    if (message.model.html != message.model.text) {
      matrixMessage.format = "org.matrix.custom.html";
      matrixMessage.formatted_body = message.model.html;
    }

    if (message.model.status) {
      matrixMessage.msgtype = "m.emote";

      // Strip the leading @username mention from the body text
      var userNameQuoted = quotemeta(fromUser.username);

      // Turn  "@username does something here" into "does something here"
      matrixMessage.body =
        matrixMessage.body.replace(new RegExp("^@" + userNameQuoted + " "), "");

      // HTML is harder. Applying regexp mangling to an HTML string. Not a lot
      //   better we can do about this, unless gitter gives us the underlying
      //   message in a better way.

      // Turn
      //   <span class="mention" ...>@username</span> does something here
      // into
      //   does something here
      matrixMessage.formatted_body =
        matrixMessage.formatted_body.replace(new RegExp("^<span [^>]+>@" + userNameQuoted + "</span> "), "");
    }

    // TODO(paul): consider if we want to annotate somehow if message.operation was
    //   'update'

    return user.getIntent().sendMessage(this.matrixRoomId(), matrixMessage);
  });
};

BridgedRoom.prototype.onMatrixMessage = function(message) {
  var from = this._bridge.mangleName(message.user_id);

  // gitter supports Markdown. We'll use that to apply a little formatting
  // to make understanding the text a little easier
  if (message.content.msgtype == 'm.emote') {
    // wrap emote messages in *italics*
    // We'll have to also escape any *s in the message so they don't confuse
    //   markdown
    var text = '*' + (from + ' ' + message.content.body).replace(/\*/g, '\\*') + '*';
    this._gitterRoom.sendStatus(text);
  }
  else {
    // wrap the sender of a normal message in `fixedwidth` notation
    var text = '`' + from + '` ' + message.content.body;
    this._gitterRoom.send(text);
  }
};

module.exports = BridgedRoom;
