"use strict";

function BridgedRoom(bridge, matrixRoomModel, gitterRoomModel, gitterRoom) {
  this._bridge = bridge;
  this._matrixRoomModel = matrixRoomModel;
  this._gitterRoomModel = gitterRoomModel;
  this._gitterRoom = gitterRoom;
}

BridgedRoom.prototype.matrixRoomId = function() {
  return this._matrixRoomModel.getId();
};

BridgedRoom.prototype.gitterRoomName = function() {
  return this._gitterRoomModel.getId();
};

BridgedRoom.prototype.onGitterMessage = function(message) {
  var fromUser = message.model.fromUser;

  console.log('gitter->' + this.gitterRoomName() + ' from ' + fromUser.username + ':', message.model.text)

  var intent = this._bridge.getIntentFromLocalpart('gitter_' + fromUser.username);
  // TODO(paul): this sets the profile name *every* line. Surely there's a way to do
  // that once only, lazily, at user account creation time?
  intent.setDisplayName(fromUser.displayName + ' (Gitter)');

  // TODO(paul): We could send an HTML message if we looked in message.model.html
  intent.sendText(this.matrixRoomId(), message.model.text);
};

BridgedRoom.prototype.onMatrixMessage = function(message) {
  // gitter supports Markdown. We'll use that to apply a little formatting
  // to make understanding the text a little easier
  var text = '*<' + message.user_id + '>*: ' + message.content.body

  this._gitterRoom.send(text);
};

module.exports = BridgedRoom;
