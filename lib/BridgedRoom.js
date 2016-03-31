"use strict";

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
  var self = this;

  // We have to find out our own gitter user ID so we can ignore reflections of
  // messages we sent
  //
  // TODO(paul): consider how to memoize this as it's not going to change every time
  //   we join a new room
  return this._gitter.currentUser().then(function (u) {
    var gitterUserId = u.id;

    return self._gitter.rooms.join(self.gitterRoomName()).then(function (room) {
      self._gitterRoom = room;

      var events = room.streaming().chatMessages();

      events.on('chatMessages', function(message) {
        if (message.operation !== 'create' ||
            !message.model.fromUser) {
          return;
        }

        if(message.model.fromUser.id == gitterUserId) {
          // Ignore a reflection of my own messages
          return;
        }

        self.onGitterMessage(message);
      });
    });
  });
};

BridgedRoom.prototype.onGitterMessage = function(message) {
  var fromUser = message.model.fromUser;

  console.log('gitter->' + this.gitterRoomName() + ' from ' + fromUser.username + ':', message.model.text)

  var intent = this._bridge.getIntentFromLocalpart('gitter_' + fromUser.username);
  // TODO(paul): this sets the profile name *every* line. Surely there's a way to do
  // that once only, lazily, at user account creation time?
  intent.setDisplayName(fromUser.displayName + ' (Gitter)');

  var matrixMessage = {
    msgtype: "m.text",
    body: message.model.text,
  };

  // Pull out the HTML part of the body if it's not just plain text
  if (message.model.html != message.model.text) {
    matrixMessage["format"] = "org.matrix.custom.html";
    matrixMessage["formatted_body"] = message.model.html;
  }

  intent.sendMessage(this.matrixRoomId(), matrixMessage);
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

  var text = '*<' + from + '>*: ' + message.content.body

  this._gitterRoom.send(text);
};

module.exports = BridgedRoom;
