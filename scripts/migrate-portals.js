#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');
const { MatrixClient, LogService } = require('matrix-bot-sdk');

LogService.setLevel('ERROR');

const client = new MatrixClient(process.env.MATRIX_URL, process.env.MATRIX_AT);

const dryRun = process.env.DRY_RUN ? process.env.DRY_RUN === 'true' : true;

const rl = readline.createInterface({
    input: fs.createReadStream(process.env.ROOM_STORE || './room-store.db'),
    output: process.stdout,
    terminal: false
});

let portalRooms = [];

rl.on('line', (line) => {
    const roomEntry = JSON.parse(line);
    if (!roomEntry.matrix_id) {
        return;
    }
    if (!roomEntry.matrix_id.endsWith('matrix.org')) {
        return;
    }
    if (!roomEntry || !roomEntry.data || !roomEntry.data.portal) {
        return;
    }
    const gitterRoomId = roomEntry.remote_id;
    const oldMatrixRoomId = roomEntry.matrix_id;
    const localpart = gitterRoomId.replace('/', '_');
    const alias = `#${localpart}:gitter.im`;
    portalRooms.push({gitterRoomId, oldMatrixRoomId, alias});
});

async function migrateRoom({gitterRoomId, oldMatrixRoomId, alias}) {
    const powerLevels = await client.getRoomStateEvent(oldMatrixRoomId, 'm.room.power_levels', '');
    if (powerLevels.users["@gitterbot:matrix.org"] !== 100) {
        console.log(`${gitterRoomId} ${oldMatrixRoomId} PL for bot is not 100.`);
        await client.sendMessage(oldMatrixRoomId, `The matrix.org Gitter bridge has been discontinued. You can view this channel on the new bridge over at ${alias}`);
        return;
    }
    console.log("Joining new room...");
    let targetRoomId;
    try {
        targetRoomId = await client.joinRoom(alias);
    } catch (ex) {
        if (ex.body && ex.body.errcode === 'M_NOT_FOUND') {
            console.log(`${gitterRoomId} -> does not exist anymore. Not bridging`);
            return;
        }
    }
    console.log(`${gitterRoomId} -> ${targetRoomId} (from: ${oldMatrixRoomId})`);
    if (!targetRoomId) {
        console.log(`No target room for ${gitterRoomId}!`);
    }
    if (dryRun) {
        return;
    }
    console.log("Sending power level update");
    // Disallow people from talking, should provide incentive to join the new room
    await client.sendStateEvent(oldMatrixRoomId, 'm.room.power_levels', '', {
        ...powerLevels,
        "events_default": 100,    
    });
    await client.sendText(oldMatrixRoomId, `The matrix.org Gitter bridge has been discontinued. You can view this channel on the new bridge over at ${alias}`);
    console.log("Add tombstone...");
    await client.sendStateEvent(oldMatrixRoomId, 'm.room.tombstone', '', {
        body: `The matrix.org Gitter bridge has been discontinued. You can view this channel on the new bridge over at ${alias}`,
        replacement_room: targetRoomId,
    });
    const canonicalAlias = await client.getPublishedAlias(oldMatrixRoomId);
    if (canonicalAlias) {
        console.log("Removing old alias");
        await client.deleteRoomAlias(canonicalAlias);
    }
}

rl.on('close', async () => {
    let index = 0;
    try {
        index = parseInt(await fs.promises.readFile('checkpoint.txt', 'utf-8'), 10);
    } catch (ex) {
        console.log(`Failed to fetch index, starting from the beginning`);
    }

    console.log(`Starting from index ${index}`);
    for (const entry of portalRooms.slice(index)) {
        try {
            await new Promise((r) => setTimeout(r, 3000));
            await migrateRoom(entry);
        } catch (ex) {
            console.error(`Failed to migrate`, entry, ex);
        }
        await fs.promises.writeFile('checkpoint.txt', `${index}`, 'utf-8');
        index++;
    }
})