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
    if (!roomEntry || !roomEntry.data || !roomEntry.data.portal) {
        return;
    }
    const gitterRoomId = roomEntry.remote_id;
    const oldMatrixRoomId = roomEntry.matrix_id;
    const localpart = gitterRoomId.replace('/', '_');
    const alias = `#${localpart}:gitter.im`;
    portalRooms.push({gitterRoomId, oldMatrixRoomId, alias});
});

async function getNewRoomId(alias) {
    try {
        const targetRoomId = await client.resolveRoom(alias);
        return { targetRoomId, joined: false };
    } catch (ex) {
        if (dryRun) {
            return {
                targetRoomId: '!noroomyet:gitter.im',
                joined: false,
            };
        }
        console.log("Joining new gitter room...");
        await new Promise((r) => setTimeout(r, 5000)); // Joins cost more in rate limits
        return {
            targetRoomId: await client.joinRoom(alias),
            joined: true,
        };
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
    for (const {gitterRoomId, oldMatrixRoomId, alias} of portalRooms.slice(index)) {
        await new Promise((r) => setTimeout(r, 3000));
        const {targetRoomId, joined} = await getNewRoomId(alias);
        console.log(`${gitterRoomId} -> ${targetRoomId} (from: ${oldMatrixRoomId})`);
        if (!targetRoomId) {
            console.log(`No target room for ${gitterRoomId}!`);
        }
        if (!dryRun) {
            console.log("Joining new room...");
            await client.joinRoom(alias)
            console.log("Add tombstone...");
            await client.sendStateEvent(oldMatrixRoomId, 'm.room.tombstone', '', {
                body: `The matrix.org Gitter bridge has been discontinued. You can view this channel on the new bridge over at ${alias}`,
                replacement_room: targetRoomId,
            });
            console.log("Sending power level update");
            // Disallow people from talking, should provide incentive to join the new room
            await client.sendStateEvent(oldMatrixRoomId, 'm.room.power_levels', '', {
                "ban": 50,
                "events": {
                    "m.room.avatar": 50,
                    "m.room.canonical_alias": 50,
                    "m.room.history_visibility": 100,
                    "m.room.name": 50,
                    "m.room.power_levels": 100
                },
                "events_default": 100,
                "invite": 0,
                "kick": 50,
                "redact": 50,
                "state_default": 50,
                "users": {
                    "@gitterbot:matrix.org": 100
                },
                "users_default": 0            
            });
            if (joined) {
                console.log("Parting joined room");
                await client.leaveRoom(targetRoomId);
            }
        }
        await fs.promises.writeFile('checkpoint.txt', `${index}`, 'utf-8');
        index++;
    }
})