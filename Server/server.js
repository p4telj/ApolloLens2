/* Imports & Setup */

// requirements
const WebSocketServer = require('ws').Server;
const ip = require("ip");
const fs = require("fs");
const path = require("path");

// network info
const addr = ip.address();
const port = process.env.PORT || "8080";

// the server itself
const wss = new WebSocketServer({ port: port });

// error codes
const ServerFullCode = 4000;
const ServerFullError = 'ServerFullError';

// used for logging
let uniqueConnectionId = 0;

// room management
// room = {
//    source = null; // holds ws object. room dependent on source, so this maintains 1 source per room invariant.
//    clients = []; // holds ws objects
//    lastPingedClient = -1; // ensure server responds to appropriate client for webrtc initialization
//    lpcLock = 0; // ensure server responds to appropriate client for webrtc initialization
// }
let rooms = {};

// message configuration
let messageHandlers = {};
let messageKey = "";
let messageValue = "";


/* Helper Functions */

// message creation helper
function createMessage(key, val) {
    let message = {}
    message[messageKey] = key;
    message[messageValue] = val;
    return JSON.stringify(message);
}


/* Handler Functions */

// REGISTRATION: client -> signaller || source -> signaller
function registrationHandler(ws) {
    // set id to message contents
    ws.id = ws.message;
    if (ws.id !== "source" && ws.id !== "client") {
        console.log(`Rejected connection ${ws.id} ${ws.uid}`);
        ws.close(ServerFullCode, ServerFullError);
        return;
    }

    console.log(`Registered connection ${ws.uid} as ${ws.id}`);
}

// ROOM CREATION: source -> signaller
function roomCreateHandler(ws) {
    // error handling: room already exists
    if (ws.message in rooms || ws.message === "") {
        console.log(ws.message === "" ? "Empty room name is not allowed." : `Source ${ws.uid} is requesting room ${ws.message}. Already exists.`);
        ws.send(createMessage("RoomCreate", ""));
        return;
    }

    // create default room
    var room = {
        source : null,
        clients : [],
        lastPingedClient : -1,
        lpcLock : 0
    }

    // adds default room to rooms object & notifies source of success
    rooms[ws.message] = room;
    console.log(`${ws.id} ${ws.uid} created room ${ws.message}`);
    ws.send(createMessage("RoomCreate", ws.message));
}

// ROOM POLL: client -> signaller
function roomPollHandler(ws) {
    console.log(`${ws.id} ${ws.uid} polling rooms...`);
    ws.send(createMessage("RoomPoll", rooms.keys()));
}

// ROOM JOIN: client -> signaller
function roomJoinHandler(ws) {
    // does room exist
    if (!(ws.message in rooms)) {
        console.log(`${ws.id} ${ws.uid} requesting to join nonexistent room ${ws.message}`);
        ws.send(createMessage("RoomJoin", ""));
    }
    // room already has a source
    else if (ws.id === "source" && rooms[ws.message].source !== null) {
        console.log(`Source ${ws.uid} requesting to join room ${ws.message} but rejected as it already has a source.`);
        ws.send(createMessage("RoomJoin", ""));
    }
    // client attempting to join a room without a source (nondeterministic request)
    else if (ws.id === "client" && rooms[ws.message].source === null) {
        console.log(`Client ${ws.uid} requesting to join room ${ws.message} but rejected as it has no source.`);
        ws.send(createMessage("RoomJoin", ""));
    }

    // join room
    ws.rid = ws.message;

    if (ws.id === "source") {
        rooms[ws.rid].source = ws;
        // no one to notify as source must be first inhabitant
    }
    else {
        rooms[ws.rid].clients.push(ws);
        // notify source/clients
        rooms[ws.rid].source.send(createMessage("Plain", `${ws.id} ${ws.uid} joined room ${ws.rid}`));
        rooms[ws.rid].clients.forEach(client => {
            if (client !== ws) client.send(createMessage("Plain", `${ws.id} ${ws.uid} joined room ${ws.rid}`));
        });
    }

    // notify requestor of successful join
    console.log(`${ws.id} ${ws.uid} joined room ${ws.rid}`);
    ws.send(createMessage("RoomJoin", ws.rid));
}

// PLAIN MESSAGE: client -> signaller -> source || source -> signaller -> all clients
function plainMessageHandler(ws) {
    if (ws.rid === null) return;

    ws.target === "source" ? rooms[ws.rid].source.send(ws.raw) : rooms[ws.rid].clients.forEach((client => {
        if (client !== ws) client.send(ws.raw);
    }));
}

// OFFER: client -> signaller -> source
function offerHandler(ws) {
    if (ws.rid === null) return;

    // ensures only 1 connection at a time
    if (rooms[ws.rid].lpcLock) return;
    rooms[ws.rid].lpcLock = 1;
    rooms[ws.rid].lastPingedClient = ws.uid;

    // broadcast connecting client uid to source
    rooms[ws.rid].source.send(createMessage("Register", lastPingedClient.toString()));
    // forward offer to source
    rooms[ws.rid].source.send(ws.raw);
}

// ANSWER: source -> signaller -> specific client
function answerHandler(ws) {
    if (ws.rid === null) return;

    rooms[ws.rid].clients.forEach((client) => {
        if (client.uid === rooms[ws.rid].lastPingedClient) client.send(ws.raw);
    });
}

// ICE CANDIDATE: client -> signaller -> source || source -> signaller -> specific client
function iceCandidateHandler(ws) {
    if (ws.rid === null) return;

    if (ws.target === "source") {
        if (ws.uid !== rooms[ws.rid].lastPingedClient) return;
        rooms[ws.rid].source.send(ws.raw);
    }
    else {
        rooms[ws.rid].clients.forEach((client) => {
            if (client.uid === rooms[ws.rid].lastPingedClient) client.send(ws.raw);
        });
        // release lock
        rooms[ws.rid].lpcLock = 0;
    }
}

// CURSOR UPDATE: client -> signaller -> all other clients
function cursorUpdateHandler(ws) {
    if (ws.rid === null) return;

    rooms[ws.rid].clients.forEach((client) => {
        if (client !== ws) client.send(ws.raw);
    });
}

/* Configuration */

try {
    let rawData = fs.readFileSync(path.resolve(__dirname, '../Library/Utilities/config.json'));
    let jsonData = JSON.parse(rawData);

    // associate proper handlers
    messageHandlers["Register"] = registrationHandler;
    messageHandlers["RoomCreate"] = roomCreateHandler;
    messageHandlers["RoomPoll"] = roomPollHandler;
    messageHandlers["RoomJoin"] = roomJoinHandler;
    messageHandlers["Plain"] = plainMessageHandler;
    messageHandlers["Offer"] = offerHandler;
    messageHandlers["Answer"] = answerHandler;
    messageHandlers["IceCandidate"] = iceCandidateHandler;
    messageHandlers["CursorUpdate"] = cursorUpdateHandler;


    // error check the above with the config file to ensure no difference in message types
    for (mtype in messageHandlers) {
        let diff = true;
        for (mt in jsonData.Signaller.MessageTypes) {
            if (jsonData.Signaller.MessageTypes[mt] == mtype) {
                diff = false;
                break;
            }
        }
        if (diff) {
            console.log("Please check messageHandlers and config.json messageTypes to ensure compatibility.");
        }
    }

    messageKey = jsonData.Signaller.MessageKey;
    messageValue = jsonData.Signaller.MessageValue;
}
catch {
    console.log("Failed to parse config.json.");
    process.exit(1);
}
console.log("Loaded configuration from config.json. Current messageTypes:");
console.log(messageHandlers);


/* Connection */

// handler for a new connection to the server
wss.on('connection', function connection(ws, request, client) {

    // establish connection identifiers
    ws.uid = uniqueConnectionId++; // unique connection ID
    ws.id = null; // "source" or "client"
    ws.rid = null; // room ID

    console.log(`Opened connection ${ws.uid}`);

    // handler for receiving a message on the socket
    ws.on('message', (rawMessage) => {
        ws.target = ws.id === null ? null : (ws.id === "client" ? "source" : "client");

        // JSON only. exception handling will catch non-JSON artifacts and return an error.
        let message;
        try {
            message = JSON.parse(rawMessage);
        }
        catch(e) {
            console.log(`Failed to parse json message from ${ws.id} ${ws.rid}:${ws.uid}`);
            return;
        }

        console.log(`==== Message received from ID (${ws.id}) Room:UID (${ws.rid}:${ws.uid}) ====`);
        console.log(message);

        // return error if message type is invalid.
        if (message[messageKey] in messageHandlers === false) {
            ws.send(createMessage("Plain", "Invalid message type."));
            return;
        }

        // call appropriate handler.
        ws.raw = rawMessage;
        ws.message = message[messageValue];
        messageHandlers[message[messageKey]](ws);
    });

    // handler for the socket connection closing
    ws.on('close', () => {
        console.log(`Closed connection ${ws.id} ${ws.rid}:${ws.uid}`);

        // only valid if room ID exists
        if (ws.rid === null) return;

        if (ws.id === "source") {
            console.log(`${ws.rid}:${ws.uid} was source. Shutting down all clients in room ${ws.rid}.`);
            rooms[ws.rid].clients.forEach((client) => {
                client.send(createMessage("Shutdown", ""));
                console.log(`Sent shutdown to ${client.id} ${client.rid}:${client.uid}`);
            });

            delete rooms[ws.rid];
        }
        else if (ws.id === "client" && rooms[ws.rid].source.readyState === ws.OPEN) {
            rooms[ws.rid].source.send(createMessage("Shutdown", ws.uid.toString()));
            console.log(`Sent client ${client.uid} shutdown to the source`);
        }
    });
});

console.log(`Running on port ${port} at address ${addr}`);