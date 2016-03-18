"use strict";

function BridgedRoom(bridge, config, matrixRoom, gitterRoom) {
  this._bridge = bridge;
  this._config = config;
  this._matrixRoom = matrixRoom;
  this._gitterRoom = gitterRoom;
}

BridgedRoom.prototype.matrixRoomId = function() {
  return this._matrixRoom.getId();
};

BridgedRoom.prototype.gitterRoomName = function() {
  return this._gitterRoom.getId();
};

BridgedRoom.prototype.onGitterMessage = function(message) {
  var fromUser = message.model.fromUser;

  console.log('gitter->' + this.gitterRoomName() + ' from ' + fromUser.username + ':', message.model.text)

  var intent = this._bridge.getIntent('@gitter_' + fromUser.username + ':' + this._config.matrix_user_domain);
  // TODO(paul): this sets the profile name *every* line. Surely there's a way to do
  // that once only, lazily, at user account creation time?
  intent.setDisplayName(fromUser.displayName + ' (Gitter)');

  // TODO(paul): We could send an HTML message if we looked in message.model.html
  intent.sendText(this.matrixRoomId(), message.model.text);
};

module.exports = BridgedRoom;
