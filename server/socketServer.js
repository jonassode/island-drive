/**
 * The socket layer: rooms, connections, and the tick loop that drives them.
 *
 * Attaches to an existing `http.Server` rather than listening on its own port, so the very
 * same code serves the game in three places: `vite` (dev), `vite preview` (the smoke test) and
 * `node server/index.js` (production, with `dist/` in front of it). Only the `/ws` path is
 * claimed, which leaves Vite's own HMR socket alone.
 *
 * There is one clock per room: it ticks at `MULTIPLAYER.tickRate` and broadcasts every
 * `tickRate / snapshotRate` ticks. A room exists only while it holds a player — an empty room
 * stops its timer, is dropped, and the next visitor gets a fresh island.
 */

import { WebSocketServer } from 'ws';
import { createRoom } from './room.js';
import {
	decode, error as errorMessage, full, input as inputMessage, join, leave, newIsland,
	readInputBatch, respawn, room as roomMessage, snapshot, welcome,
} from '../src/multiplayer/protocol.js';
import { MULTIPLAYER, WORLD } from '../src/config.js';

/** Room ids a client may ask for: short, and safe to log. Anything else falls back to default. */
const ROOM_ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Normalises a requested room id.
 *
 * @param {string|null} value Raw `?room=` value.
 * @param {object} config Server tunables.
 * @returns {string} A safe room id.
 */
function roomId( value, config ) {

	if ( typeof value === 'string' && ROOM_ID.test( value ) ) return value;

	return config.room;

}

/**
 * Reads a room seed from a request, if it looks like one.
 *
 * @param {string|null} value Raw `?seed=` value.
 * @returns {number|null} The seed, or null when it should be drawn at random.
 */
function roomSeed( value ) {

	if ( typeof value !== 'string' ) return null;

	const parsed = Number.parseInt( value, 10 );

	if ( Number.isFinite( parsed ) === false ) return null;

	return Math.min( WORLD.maxSeed, Math.abs( parsed ) );

}

/**
 * Starts the multiplayer server on an HTTP server.
 *
 * @param {import('http').Server} httpServer Server to attach the upgrade handler to.
 * @param {object} [options] Options.
 * @param {object} [options.config] Overrides for {@link MULTIPLAYER}.
 * @param {Function} [options.log] Log sink; nothing is logged by default.
 * @returns {{ dispose: () => void, rooms: Map<string, object>, url: string }} The running server.
 */
export function attachGameServer( httpServer, options = {} ) {

	const config = { ...MULTIPLAYER, ...options.config };
	const log = options.log ?? ( () => {} );
	const path = config.path;
	const ticksPerSnapshot = Math.max( 1, Math.round( config.tickRate / config.snapshotRate ) );

	const wss = new WebSocketServer( { noServer: true } );
	/** Live rooms, keyed by id. Each holds the authoritative simulation and its sockets. */
	const rooms = new Map();

	/**
	 * Sends one frame, ignoring a socket that has already gone away.
	 *
	 * @param {object} ws WebSocket.
	 * @param {object} message Message to send.
	 * @returns {void}
	 */
	function send( ws, message ) {

		if ( ws.readyState !== ws.OPEN ) return;
		ws.send( JSON.stringify( message ) );

	}

	/**
	 * Sends a frame to everyone in a room.
	 *
	 * @param {object} entry Room entry.
	 * @param {object} message Message to send.
	 * @returns {void}
	 */
	function broadcast( entry, message ) {

		for ( const ws of entry.members.values() ) send( ws, message );

	}

	/**
	 * One simulation step of a room, plus its snapshot when it is due.
	 *
	 * The drain happens *before* the snapshot is built, because a snapshot carries the events
	 * of the ticks since the last one.
	 *
	 * @param {object} entry Room entry.
	 * @returns {void}
	 */
	function step( entry ) {

		entry.room.tick();
		entry.ticksSinceSnapshot ++;

		if ( entry.ticksSinceSnapshot < ticksPerSnapshot ) return;

		entry.ticksSinceSnapshot = 0;

		const events = entry.room.drainEvents();
		broadcast( entry, snapshot( entry.room.tickCount, entry.room.poses(), events ) );

	}

	/**
	 * Looks a room up, creating it on first join.
	 *
	 * @param {string} id Room id.
	 * @param {number|null} seed Requested island seed.
	 * @returns {object|null} The room entry, or null when there is no room and no capacity.
	 */
	function openRoom( id, seed ) {

		const existing = rooms.get( id );
		if ( existing !== undefined ) return existing;
		if ( rooms.size >= config.maxRooms ) return null;

		const room = createRoom( { id, seed, config } );
		const entry = {
			room,
			/** player id -> socket */
			members: new Map(),
			timer: null,
			ticksSinceSnapshot: 0,
		};

		rooms.set( id, entry );
		log( `room ${id} opened (seed ${room.seed})` );

		return entry;

	}

	/**
	 * Shuts a room down once its last member has left.
	 *
	 * @param {string} id Room id.
	 * @param {object} entry Room entry.
	 * @returns {void}
	 */
	function closeRoom( id, entry ) {

		if ( entry.timer !== null ) clearInterval( entry.timer );

		rooms.delete( id );
		log( `room ${id} closed` );

	}

	/**
	 * Handles a fresh connection.
	 *
	 * @param {object} ws WebSocket.
	 * @param {URL} url Request URL, whose query carries the room, the seed and the name.
	 * @returns {void}
	 */
	function handleConnection( ws, url ) {

		const id = roomId( url.searchParams.get( 'room' ), config );
		const entry = openRoom( id, roomSeed( url.searchParams.get( 'seed' ) ) );

		if ( entry === null ) {

			send( ws, full( config.maxPlayers ) );
			ws.close( 1013, 'no room capacity' ); // 1013 = try again later
			return;

		}

		const player = entry.room.addPlayer( { name: url.searchParams.get( 'name' ) } );

		if ( player === null ) {

			send( ws, full( config.maxPlayers ) );
			ws.close( 1013, 'room full' );
			return;

		}

		entry.members.set( player.id, ws );
		ws.playerId = player.id;
		ws.roomId = id;
		ws.isAlive = true;

		send( ws, welcome( {
			room: id,
			you: player.id,
			seed: entry.room.seed,
			players: entry.room.roster(),
			tickRate: config.tickRate,
			snapshotRate: config.snapshotRate,
		} ) );

		// Everyone else is told about the new car, and gets a fresh roster with its slot.
		for ( const [ memberId, memberWs ] of entry.members ) {

			if ( memberId === player.id ) continue;

			send( memberWs, welcome( {
				room: id,
				you: memberId,
				seed: entry.room.seed,
				players: entry.room.roster(),
				tickRate: config.tickRate,
				snapshotRate: config.snapshotRate,
			} ) );

		}

		// The single place a room's clock is started, so it can never be started twice.
		if ( entry.timer === null ) {

			entry.timer = setInterval( () => step( entry ), 1000 / config.tickRate );

		}

		log( `player ${player.id} (${player.name}) joined room ${id}` );

		ws.on( 'message', ( data ) => handleMessage( entry, ws, data ) );
		ws.on( 'pong', () => {

			ws.isAlive = true;

		} );
		ws.on( 'close', () => handleClose( id, entry, player.id ) );
		ws.on( 'error', () => ws.terminate() );

	}

	/**
	 * Handles one frame from a client.
	 *
	 * @param {object} entry Room entry.
	 * @param {object} ws WebSocket.
	 * @param {string|Uint8Array} data Frame payload.
	 * @returns {void}
	 */
	function handleMessage( entry, ws, data ) {

		const message = decode( data );

		if ( message === null ) {

			send( ws, errorMessage( 'unreadable frame' ) );
			return;

		}

		const playerId = ws.playerId;

		if ( message.t === 'input' ) {

			const batch = readInputBatch( message );

			if ( batch === null ) {

				send( ws, errorMessage( 'malformed input batch' ) );
				return;

			}

			entry.room.queueInputs( playerId, batch.inputs );
			return;

		}

		if ( message.t === 'respawn' ) {

			entry.room.respawn( playerId );
			return;

		}

		if ( message.t === 'newIsland' ) {

			if ( playerId !== entry.room.host ) {

				send( ws, errorMessage( 'only the host can change the island' ) );
				return;

			}

			entry.room.newIsland();
			broadcast( entry, roomMessage( { seed: entry.room.seed, players: entry.room.roster() } ) );
			log( `room ${ws.roomId} regenerated (seed ${entry.room.seed})` );
			return;

		}

		if ( message.t === 'name' ) {

			entry.room.setName( playerId, message.v );

			const me = entry.room.roster().find( ( other ) => other.id === playerId );
			if ( me !== undefined ) broadcast( entry, join( me ) );

			return;

		}

		send( ws, errorMessage( `unknown frame "${message.t}"` ) );

	}

	/**
	 * Handles a socket going away, which is also how a room is emptied.
	 *
	 * @param {string} id Room id.
	 * @param {object} entry Room entry.
	 * @param {number} playerId Player id.
	 * @returns {void}
	 */
	function handleClose( id, entry, playerId ) {

		entry.members.delete( playerId );
		entry.room.removePlayer( playerId );

		broadcast( entry, leave( playerId ) );
		log( `player ${playerId} left room ${id}` );

		if ( entry.members.size === 0 ) closeRoom( id, entry );

	}

	/**
	 * Claims the game path, leaving every other upgrade (Vite's HMR socket) to whoever else is
	 * listening on the server.
	 *
	 * @param {import('http').IncomingMessage} request Upgrade request.
	 * @param {import('net').Socket} socket Raw socket.
	 * @param {Buffer} head First packet.
	 * @returns {void}
	 */
	function handleUpgrade( request, socket, head ) {

		let url;

		try {

			url = new URL( request.url, 'http://localhost' );

		} catch {

			return; // not ours, and not parseable: leave it alone

		}

		if ( url.pathname !== path ) return;

		wss.handleUpgrade( request, socket, head, ( ws ) => handleConnection( ws, url ) );

	}

	httpServer.on( 'upgrade', handleUpgrade );

	// Unresponsive clients are pinged and dropped: a car frozen mid-air is worse than a
	// disconnect, and a dropped socket is exactly the `leave` the room already handles.
	const heartbeat = setInterval( () => {

		for ( const entry of rooms.values() ) {

			for ( const ws of entry.members.values() ) {

				if ( ws.isAlive === false ) {

					ws.terminate();
					continue;

				}

				ws.isAlive = false;
				ws.ping();

			}

		}

	}, config.heartbeatMs );

	return {
		/** Live rooms, for tests. */
		rooms,

		/** The path clients connect to. */
		url: path,

		/** Stops the tick loops and the heartbeat, and drops every socket. */
		dispose() {

			clearInterval( heartbeat );

			for ( const entry of rooms.values() ) {

				if ( entry.timer !== null ) clearInterval( entry.timer );

				for ( const ws of entry.members.values() ) ws.terminate();

			}

			rooms.clear();
			httpServer.removeListener( 'upgrade', handleUpgrade );
			wss.close();

		},
	};

}